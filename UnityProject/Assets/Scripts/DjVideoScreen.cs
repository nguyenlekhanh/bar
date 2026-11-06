using System;
using System.Collections;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.Video;

namespace TikTokLiveGame
{
    /// <summary>
    /// Plays an MP4 into a RenderTexture (H.264 on Windows through the OS media stack).
    ///
    /// Two modes:
    ///  * AutoStart = true  : legacy DJ screen — finds a file in DJ_VIDEO at Start().
    ///  * AutoStart = false : pure texture provider, driven by BackgroundManager
    ///                        through PlayVideo()/StopVideo()/CurrentTexture.
    /// </summary>
    public sealed class DjVideoScreen : MonoBehaviour
    {
        public bool AutoStart = true;
        public bool Loop = true;
        public float PrepareTimeoutSeconds = 6f;
        public float SlideSeconds = 8f;

        public event Action<string> Failed;

        public Texture CurrentTexture => videoTexture;
        public string CurrentPath { get; private set; } = string.Empty;
        public bool IsReady => player != null && player.isPrepared && videoTexture != null;

        /// <summary>Real source size and length of the clip, known after prepare.</summary>
        public uint Width { get; private set; }
        public uint Height { get; private set; }
        public double Duration { get; private set; }

        private VideoPlayer player;
        private RenderTexture videoTexture;
        private Material screenMaterial;
        private Texture2D imageTexture;
        private string[] imagePaths = Array.Empty<string>();
        private int imageIndex;
        private float nextSlideAt;
        private Coroutine prepareWatchdog;
        private Renderer targetRenderer;
        private bool prepared;
        private bool stopping;

        private void Awake() => targetRenderer = GetComponent<Renderer>();

        private void Start()
        {
            if (!AutoStart) return;

            string path = FindVideoPath();
            if (!string.IsNullOrEmpty(path))
            {
                PlayVideo(path);
                return;
            }

            imagePaths = FindImagePaths();
            if (imagePaths.Length > 0)
            {
                ShowImage(0);
                return;
            }

            Debug.Log("DJ screen is ready. Add a video or PNG/JPG image to the DJ_VIDEO folder.");
        }

        private void Update()
        {
            // The VideoPlayer writes straight into videoTexture. Unity normalises
            // render-texture orientation per graphics API (it renders "upside down"
            // into textures on D3D/Metal so both conventions match), so the texture
            // is sampled exactly like a PNG backdrop: no extra flip, no extra copy,
            // and nothing to redo every frame.
            if (imagePaths.Length <= 1 || Time.unscaledTime < nextSlideAt) return;
            ShowImage((imageIndex + 1) % imagePaths.Length);
        }

        /// <summary>Starts (or restarts) playback. Returns false when the source is unusable.</summary>
        public bool PlayVideo(string pathOrUrl)
        {
            if (string.IsNullOrWhiteSpace(pathOrUrl))
            {
                Fail("Video path rỗng.");
                return false;
            }

            StopVideo();
            imagePaths = Array.Empty<string>();
            CurrentPath = pathOrUrl;
            prepared = false;

            screenMaterial = EnsureMaterial();
            player = gameObject.AddComponent<VideoPlayer>();
            player.playOnAwake = false;
            player.isLooping = Loop;
            player.source = VideoSource.Url;
            player.url = ToUrl(pathOrUrl);
            player.renderMode = VideoRenderMode.RenderTexture;
            videoTexture = CreateTexture(1280, 720, "Background Video");
            player.targetTexture = videoTexture;
            player.audioOutputMode = VideoAudioOutputMode.None;
            player.skipOnDrop = true;
            player.errorReceived += OnPlayerError;
            player.prepareCompleted += OnPrepared;
            player.Prepare();

            prepareWatchdog = StartCoroutine(WatchPrepare());
            Debug.Log($"[Video] loading {pathOrUrl}");
            return true;
        }

        public void StopVideo()
        {
            if (stopping) return;
            stopping = true;
            try
            {
                if (prepareWatchdog != null)
                {
                    StopCoroutine(prepareWatchdog);
                    prepareWatchdog = null;
                }

                prepared = false;

                if (player != null)
                {
                    player.prepareCompleted -= OnPrepared;
                    player.errorReceived -= OnPlayerError;
                    try { player.Stop(); } catch { }
                    Destroy(player);
                    player = null;
                }

                Release(videoTexture);
                videoTexture = null;
            }
            finally
            {
                stopping = false;
            }
        }

        private void OnPlayerError(VideoPlayer source, string message) => Fail($"Video lỗi: {message}");

        private void OnPrepared(VideoPlayer source)
        {
            if (prepareWatchdog != null)
            {
                StopCoroutine(prepareWatchdog);
                prepareWatchdog = null;
            }

            ResizeTextures(source.width, source.height);
            source.Play();
            prepared = true;
            Width = source.width;
            Height = source.height;
            Duration = source.frameRate > 0.01f ? source.frameCount / source.frameRate : 0d;
            Debug.Log($"[Video] playing {CurrentPath} ({source.width}x{source.height}, {Duration:0.#}s)");
        }

        private IEnumerator WatchPrepare()
        {
            float deadline = Time.unscaledTime + Mathf.Max(1f, PrepareTimeoutSeconds);
            while (!prepared && Time.unscaledTime < deadline) yield return null;
            prepareWatchdog = null;
            if (!prepared) Fail("Video không chuẩn bị xong (timeout).");
        }

        /// <summary>Keeps the RT at the video's own resolution so nothing is stretched.</summary>
        private void ResizeTextures(uint width, uint height)
        {
            int targetWidth = width >= 16 ? (int)width : 1280;
            int targetHeight = height >= 16 ? (int)height : 720;
            if (videoTexture != null && videoTexture.width == targetWidth && videoTexture.height == targetHeight) return;

            RenderTexture previous = videoTexture;
            videoTexture = CreateTexture(targetWidth, targetHeight, "Background Video");
            if (player != null) player.targetTexture = videoTexture;
            if (screenMaterial != null) screenMaterial.mainTexture = videoTexture;

            // Destroy() is deferred to the end of the frame, so the renderer can
            // still finish the frame it is already drawing.
            Release(previous);
        }

        private void Fail(string message)
        {
            if (stopping) return;
            Debug.LogWarning($"[Video] {message}");
            StopVideo();
            Failed?.Invoke(message);
        }

        private Material EnsureMaterial()
        {
            if (screenMaterial != null) return screenMaterial;
            if (targetRenderer == null) return null;

            Shader shader = Shader.Find("Unlit/Texture") ?? Shader.Find("Sprites/Default");
            screenMaterial = new Material(shader) { mainTexture = videoTexture };
            targetRenderer.material = screenMaterial;
            return screenMaterial;
        }

        private static RenderTexture CreateTexture(int width, int height, string name)
        {
            RenderTexture texture = new(width, height, 0, RenderTextureFormat.ARGB32)
            {
                name = name,
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            texture.Create();
            return texture;
        }

        private static void Release(RenderTexture texture)
        {
            if (texture == null) return;
            texture.Release();
            Destroy(texture);
        }

        private static string ToUrl(string pathOrUrl)
        {
            if (pathOrUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                pathOrUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                pathOrUrl.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
            {
                return pathOrUrl;
            }

            try
            {
                return new Uri(pathOrUrl).AbsoluteUri;
            }
            catch
            {
                return pathOrUrl;
            }
        }

        private void ShowImage(int index)
        {
            if (index < 0 || index >= imagePaths.Length) return;
            byte[] bytes;
            try
            {
                bytes = File.ReadAllBytes(imagePaths[index]);
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"DJ image could not be read: {exception.Message}");
                return;
            }

            Texture2D nextTexture = new(2, 2, TextureFormat.RGBA32, false)
            {
                name = $"DJ Image {Path.GetFileName(imagePaths[index])}",
                filterMode = FilterMode.Bilinear,
                wrapMode = TextureWrapMode.Clamp
            };
            if (!nextTexture.LoadImage(bytes, false))
            {
                Destroy(nextTexture);
                Debug.LogWarning($"DJ image format is not supported: {imagePaths[index]}");
                return;
            }
            FlipPixelsVertically(nextTexture);

            Material material = EnsureMaterial();
            if (material == null) return;
            Texture2D previous = imageTexture;
            imageTexture = nextTexture;
            material.mainTexture = imageTexture;
            FitImageToScreen(imageTexture);
            if (previous != null) Destroy(previous);
            imageIndex = index;
            nextSlideAt = Time.unscaledTime + SlideSeconds;
            Debug.Log($"DJ image loaded: {imagePaths[index]}");
        }

        private void FitImageToScreen(Texture texture)
        {
            if (screenMaterial == null || texture == null || targetRenderer == null) return;
            Vector3 screenSize = targetRenderer.bounds.size;
            float screenAspect = screenSize.y > 0.001f ? screenSize.x / screenSize.y : 16f / 9f;
            float textureAspect = texture.height > 0 ? texture.width / (float)texture.height : screenAspect;
            Vector2 scale = Vector2.one;
            Vector2 offset = Vector2.zero;
            if (textureAspect > screenAspect)
            {
                scale.x = screenAspect / textureAspect;
                offset.x = (1f - scale.x) * 0.5f;
            }
            else if (textureAspect < screenAspect)
            {
                scale.y = textureAspect / screenAspect;
                offset.y = (1f - scale.y) * 0.5f;
            }
            screenMaterial.mainTextureScale = scale;
            screenMaterial.mainTextureOffset = offset;
        }

        private static void FlipPixelsVertically(Texture2D texture)
        {
            int width = texture.width;
            int height = texture.height;
            Color32[] source = texture.GetPixels32();
            Color32[] flipped = new Color32[source.Length];
            for (int row = 0; row < height; row++)
                Array.Copy(source, row * width, flipped, (height - 1 - row) * width, width);
            texture.SetPixels32(flipped);
            texture.Apply(false, false);
        }

        private static string[] RootFolders()
        {
            string buildRoot = Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;
            string projectRoot = Directory.GetParent(buildRoot)?.FullName ?? buildRoot;
            string workspaceRoot = Directory.GetParent(projectRoot)?.FullName ?? projectRoot;
            string workingFolder = Directory.GetCurrentDirectory();
            return new[] { buildRoot, projectRoot, workspaceRoot, workingFolder };
        }

        private static string FindVideoPath()
        {
            string[] extensions = { ".mp4", ".mov", ".m4v", ".webm" };
            foreach (string root in RootFolders())
            {
                foreach (string folder in new[]
                         {
                             Path.Combine(root, "DJ_VIDEO"),
                             Path.Combine(root, "LiveAssets", "Backgrounds", "videos"),
                             Path.Combine(root, "LiveAssets")
                         })
                {
                    if (!Directory.Exists(folder)) continue;
                    string file = Directory.EnumerateFiles(folder)
                        .FirstOrDefault(candidate => extensions.Contains(Path.GetExtension(candidate), StringComparer.OrdinalIgnoreCase));
                    if (!string.IsNullOrEmpty(file)) return file;
                }
            }

            return Directory.Exists(Application.streamingAssetsPath)
                ? Directory.EnumerateFiles(Application.streamingAssetsPath)
                    .FirstOrDefault(candidate => extensions.Contains(Path.GetExtension(candidate), StringComparer.OrdinalIgnoreCase))
                : null;
        }

        private static string[] FindImagePaths()
        {
            string[] extensions = { ".png", ".jpg", ".jpeg" };
            foreach (string root in RootFolders())
            {
                foreach (string folder in new[]
                         {
                             Path.Combine(root, "DJ_VIDEO"),
                             Path.Combine(root, "LiveAssets")
                         })
                {
                    if (!Directory.Exists(folder)) continue;
                    string[] files = Directory.EnumerateFiles(folder)
                        .Where(candidate => extensions.Contains(Path.GetExtension(candidate), StringComparer.OrdinalIgnoreCase))
                        .OrderBy(candidate => Path.GetFileName(candidate), StringComparer.OrdinalIgnoreCase)
                        .ToArray();
                    if (files.Length > 0) return files;
                }
            }

            return Array.Empty<string>();
        }

        private void OnDestroy()
        {
            StopVideo();
            if (imageTexture != null) Destroy(imageTexture);
            if (screenMaterial != null) Destroy(screenMaterial);
        }
    }
}
