using System;
using System.Collections;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;

namespace TikTokLiveGame
{
    public enum BackgroundFitMode
    {
        Native,
        Fit,
        Fill
    }

    public enum BackgroundKind
    {
        Image,
        Video
    }

    /// <summary>
    /// Swaps the club backdrop texture at runtime (PNG/JPG/MP4) and keeps the
    /// four backdrop quads sized and positioned behind the stage.
    ///
    /// The four quads are built by ClubSceneBuilder; this component only owns
    /// the textures it created, so the original nenamphu.png texture loaded at
    /// build time is never destroyed.
    /// </summary>
    public sealed class BackgroundManager : MonoBehaviour
    {
        /// <summary>Backdrop plane sits behind the DJ (world z -19.5) and the truss.</summary>
        public const float BackdropZ = -22f;
        public const string LegacyFile = "nenamphu.png";

        private const float FrameHeight = 40f;
        private const float FrameWidth = FrameHeight * (16f / 9f);
        private const float FloorY = -3f;

        public static BackgroundManager Instance { get; private set; }

        public string CurrentFile { get; private set; } = LegacyFile;
        public BackgroundFitMode CurrentFit { get; private set; } = BackgroundFitMode.Native;
        public BackgroundKind CurrentKind { get; private set; } = BackgroundKind.Image;

        private Transform centerQuad;
        private Transform leftQuad;
        private Transform rightQuad;
        private Transform ceilingQuad;
        private Material centerMaterial;
        private Material leftMaterial;
        private Material rightMaterial;
        private Material ceilingMaterial;

        private Texture activeTexture;
        private bool ownsActiveTexture;
        private string lastImageFile = LegacyFile;
        private BackgroundFitMode lastImageFit = BackgroundFitMode.Native;
        private string resolvedServerUrl;
        private DjVideoScreen videoSource;
        private BackgroundFitMode pendingVideoFit = BackgroundFitMode.Native;
        private bool restoring;
        private int pendingGeneration = -1;
        private bool suppressAck;
        private TikTokWebSocketClient ackClient;
        private Quaternion centerBaseRotation = Quaternion.identity;
        private Quaternion leftBaseRotation = Quaternion.identity;
        private Quaternion rightBaseRotation = Quaternion.identity;
        private Quaternion ceilingBaseRotation = Quaternion.identity;
        private int currentRotation;
        private bool flipHorizontal;
        private bool flipVertical;

        internal static BackgroundManager Attach(
            GameObject host,
            Transform center,
            Transform left,
            Transform right,
            Transform ceiling,
            Material centerMaterial,
            Material rightMaterial,
            Material leftMaterial,
            Material ceilingMaterial,
            Texture initialTexture)
        {
            if (host == null) return null;
            BackgroundManager manager = host.GetComponent<BackgroundManager>();
            if (manager == null) manager = host.AddComponent<BackgroundManager>();
            manager.centerQuad = center;
            manager.leftQuad = left;
            manager.rightQuad = right;
            manager.ceilingQuad = ceiling;
            manager.centerMaterial = centerMaterial;
            manager.rightMaterial = rightMaterial;
            manager.leftMaterial = leftMaterial;
            manager.ceilingMaterial = ceilingMaterial;
            manager.centerBaseRotation = center != null ? center.localRotation : Quaternion.identity;
            manager.leftBaseRotation = left != null ? left.localRotation : Quaternion.identity;
            manager.rightBaseRotation = right != null ? right.localRotation : Quaternion.identity;
            manager.ceilingBaseRotation = ceiling != null ? ceiling.localRotation : Quaternion.identity;
            manager.activeTexture = initialTexture;
            manager.ownsActiveTexture = false;
            manager.CurrentFile = LegacyFile;
            manager.CurrentFit = BackgroundFitMode.Native;
            manager.CurrentKind = BackgroundKind.Image;
            return manager;
        }

        private void Awake() => Instance = this;

        private void OnDestroy()
        {
            if (videoSource != null) videoSource.Failed -= OnVideoFailed;
            if (activeTexture != null && ownsActiveTexture) Destroy(activeTexture);
            activeTexture = null;
            if (Instance == this) Instance = null;
        }

        /// <summary>Applies a config delivered by the Node bridge.</summary>
        public void Apply(BackgroundConfigPayload config)
        {
            if (config == null || string.IsNullOrWhiteSpace(config.file))
            {
                RestoreDefault();
                return;
            }

            string file = Path.GetFileName(config.file.Trim());
            if (string.IsNullOrWhiteSpace(file)) return;
            pendingGeneration = config.generation;

            BackgroundKind kind = string.Equals(config.type, "video", StringComparison.OrdinalIgnoreCase)
                ? BackgroundKind.Video
                : BackgroundKind.Image;
            BackgroundTransformPayload transform = config.transform;
            currentRotation = NormalizeRotation(transform != null ? transform.rotation : config.rotation);
            flipHorizontal = transform != null && transform.flipHorizontal;
            flipVertical = transform != null && transform.flipVertical;
            if (kind == BackgroundKind.Image)
            {
                currentRotation = 0;
                flipHorizontal = false;
                flipVertical = false;
            }

            ApplyFile(file, kind, ParseFit(config.fitMode));
        }

        public void ApplyFile(string file, BackgroundKind kind, BackgroundFitMode fit)
        {
            if (string.IsNullOrWhiteSpace(file)) return;
            file = Path.GetFileName(file);

            // Same clip, new orientation: re-layout the texture that is already
            // playing instead of restarting (or re-downloading) the video.
            if (kind == BackgroundKind.Video && videoSource != null &&
                activeTexture != null && ReferenceEquals(activeTexture, videoSource.CurrentTexture) &&
                string.Equals(CurrentFile, file, StringComparison.OrdinalIgnoreCase))
            {
                CurrentFit = fit;
                Layout(activeTexture, fit);
                ReportAck(true, null, (int)videoSource.Width, (int)videoSource.Height, videoSource.Duration);
                return;
            }

            // Same selection twice must not build a second texture.
            if (string.Equals(CurrentFile, file, StringComparison.OrdinalIgnoreCase) &&
                CurrentFit == fit && CurrentKind == kind && activeTexture != null && kind == BackgroundKind.Image)
            {
                if (videoSource != null) videoSource.StopVideo();
                ReportAck(true, null,
                    activeTexture != null ? activeTexture.width : 0,
                    activeTexture != null ? activeTexture.height : 0, 0d);
                return;
            }

            if (kind == BackgroundKind.Video) ApplyVideo(file, fit);
            else ApplyImage(file, fit);
        }

        public void RestoreDefault() => ApplyImage(LegacyFile, BackgroundFitMode.Native);

        private void ApplyImage(string file, BackgroundFitMode fit)
        {
            StopVideoIfAny();
            // Images carry no transform, so a stale video rotation/flip must never
            // survive a switch back to a PNG/JPG.
            currentRotation = 0;
            flipHorizontal = false;
            flipVertical = false;
            CurrentKind = BackgroundKind.Image;
            CurrentFile = file;
            CurrentFit = fit;

            if (TryResolveLocal(file, "images", out string localPath))
            {
                try
                {
                    byte[] bytes = File.ReadAllBytes(localPath);
                    Texture2D texture = new(2, 2, TextureFormat.RGBA32, false);
                    if (!texture.LoadImage(bytes, false))
                    {
                        Destroy(texture);
                        OnImageFailed($"Ảnh background không đọc được: {file}");
                        return;
                    }
                    texture.name = $"Background {file}";
                    texture.wrapMode = TextureWrapMode.Clamp;
                    ApplyTexture(texture, true, fit);
                    lastImageFile = file;
                    lastImageFit = fit;
                    Debug.Log($"[Background] image applied: {file} ({fit})");
                    ReportAck(true, null, texture.width, texture.height, 0d);
                    return;
                }
                catch (Exception error)
                {
                    OnImageFailed($"Không đọc được background '{file}': {error.Message}");
                    return;
                }
            }

            StartCoroutine(DownloadImage(ResolveHttpUrl(file, "images"), file, fit));
        }

        private void ApplyVideo(string file, BackgroundFitMode fit)
        {
            CurrentKind = BackgroundKind.Video;
            CurrentFile = file;
            CurrentFit = fit;

            string source = TryResolveLocal(file, "videos", out string localPath)
                ? localPath
                : ResolveHttpUrl(file, "videos");

            if (videoSource == null)
            {
                GameObject host = new("Background Video");
                host.transform.SetParent(transform, false);
                videoSource = host.AddComponent<DjVideoScreen>();
                videoSource.AutoStart = false;
                videoSource.Failed += OnVideoFailed;
            }

            videoSource.Loop = true;
            videoSource.PrepareTimeoutSeconds = 8f;
            pendingVideoFit = fit;
            if (!videoSource.PlayVideo(source))
                OnVideoFailed($"Không phát được video background: {file}");
        }

        private void Update()
        {
            if (videoSource == null) return;
            Texture texture = videoSource.CurrentTexture;
            if (texture == null || ReferenceEquals(texture, activeTexture)) return;
            ApplyTexture(texture, false, pendingVideoFit);
            Debug.Log($"[Background] video applied: {CurrentFile}");
            ReportAck(true, null, (int)videoSource.Width, (int)videoSource.Height, videoSource.Duration);
        }

        private IEnumerator DownloadImage(string url, string file, BackgroundFitMode fit)
        {
            using UnityWebRequest request = UnityWebRequestTexture.GetTexture(url, false);
            request.timeout = 10;
            yield return request.SendWebRequest();

            if (request.result != UnityWebRequest.Result.Success)
            {
                OnImageFailed($"Không tải được background '{file}': {request.error}");
                yield break;
            }

            Texture2D texture = DownloadHandlerTexture.GetContent(request);
            if (texture == null)
            {
                OnImageFailed($"Background '{file}' không có texture.");
                yield break;
            }

            texture.name = $"Background {file}";
            texture.wrapMode = TextureWrapMode.Clamp;
            ApplyTexture(texture, true, fit);
            lastImageFile = file;
            lastImageFit = fit;
            Debug.Log($"[Background] image downloaded: {file} ({fit})");
            ReportAck(true, null, texture.width, texture.height, 0d);
        }

        private void ApplyTexture(Texture texture, bool owned, BackgroundFitMode fit)
        {
            Texture previous = activeTexture;
            bool previousOwned = ownsActiveTexture;

            activeTexture = texture;
            ownsActiveTexture = owned;
            if (centerMaterial != null) centerMaterial.mainTexture = texture;
            if (leftMaterial != null) leftMaterial.mainTexture = texture;
            if (rightMaterial != null) rightMaterial.mainTexture = texture;
            if (ceilingMaterial != null) ceilingMaterial.mainTexture = texture;

            Layout(texture, fit);

            if (previous != null && previousOwned && !ReferenceEquals(previous, texture)) Destroy(previous);
        }

        private void Layout(Texture texture, BackgroundFitMode fit)
        {
            int degrees = NormalizeRotation(currentRotation);
            bool quarterTurn = degrees == 90 || degrees == 270;

            float aspect = texture != null && texture.height > 0
                ? texture.width / (float)texture.height
                : FrameWidth / FrameHeight;

            // For 90/270 the picture is turned by rotating the quads, so the 16:9
            // frame is transposed while we work in the texture's own space.
            float frameWidth = quarterTurn ? FrameHeight : FrameWidth;
            float frameHeight = quarterTurn ? FrameWidth : FrameHeight;
            float frameAspect = frameWidth / frameHeight;

            float width;
            float height;
            float scaleX = 1f;
            float scaleY = 1f;
            float offsetX = 0f;
            float offsetY = 0f;

            switch (fit)
            {
                case BackgroundFitMode.Fit:
                    if (aspect >= frameAspect)
                    {
                        width = frameWidth;
                        height = frameWidth / aspect;
                    }
                    else
                    {
                        height = frameHeight;
                        width = frameHeight * aspect;
                    }
                    break;

                case BackgroundFitMode.Fill:
                    width = frameWidth;
                    height = frameHeight;
                    // Crop the axis that is too long: sampling a region whose
                    // aspect matches the frame is what keeps Fill undistorted.
                    if (aspect > frameAspect)
                    {
                        scaleX = frameAspect / aspect;
                        offsetX = (1f - scaleX) * 0.5f;
                    }
                    else
                    {
                        scaleY = aspect / frameAspect;
                        offsetY = (1f - scaleY) * 0.5f;
                    }
                    break;

                default:
                    height = FrameHeight;
                    width = FrameHeight * aspect;
                    break;
            }

            // Screen-space flips. A 90/270 turn swaps the quad's own axes, so the
            // flip lands on the opposite texture axis to keep "horizontal"
            // meaning horizontal on the monitor.
            if (quarterTurn ? flipVertical : flipHorizontal) Mirror(ref scaleX, ref offsetX);
            if (quarterTurn ? flipHorizontal : flipVertical) Mirror(ref scaleY, ref offsetY);

            if (centerMaterial != null)
            {
                centerMaterial.mainTextureScale = new Vector2(-scaleX, scaleY);
                centerMaterial.mainTextureOffset = new Vector2(offsetX + scaleX, offsetY);
            }
            if (rightMaterial != null)
            {
                rightMaterial.mainTextureScale = new Vector2(-3f, 1f);
                rightMaterial.mainTextureOffset = new Vector2(-1f, 0f);
            }
            if (leftMaterial != null)
            {
                leftMaterial.mainTextureScale = new Vector2(3f, 1f);
                leftMaterial.mainTextureOffset = new Vector2(-3f, 0f);
            }
            if (ceilingMaterial != null)
            {
                ceilingMaterial.mainTextureScale = new Vector2(-scaleX, -scaleY);
                ceilingMaterial.mainTextureOffset = new Vector2(offsetX + scaleX, offsetY + scaleY);
            }

            // Rotation metadata turns the picture by spinning each quad around its
            // own normal; at 0 degrees this is the identity, so PNG layout is
            // byte-for-byte the same as before.
            Quaternion spin = Quaternion.Euler(0f, 0f, degrees);

            float depth = width * 3f;
            if (centerQuad != null)
            {
                centerQuad.localRotation = centerBaseRotation * spin;
                centerQuad.position = new Vector3(0f, FloorY, BackdropZ);
                centerQuad.localScale = new Vector3(width, height, 1f);
            }
            if (leftQuad != null)
            {
                leftQuad.localRotation = leftBaseRotation * spin;
                leftQuad.position = new Vector3(width * 0.5f, FloorY, BackdropZ + depth * 0.5f);
                leftQuad.localScale = new Vector3(depth, height, 1f);
            }
            if (rightQuad != null)
            {
                rightQuad.localRotation = rightBaseRotation * spin;
                rightQuad.position = new Vector3(-width * 0.5f, FloorY, BackdropZ + depth * 0.5f);
                rightQuad.localScale = new Vector3(depth, height, 1f);
            }
            if (ceilingQuad != null)
            {
                ceilingQuad.localRotation = ceilingBaseRotation * spin;
                ceilingQuad.position = new Vector3(0f, FloorY + height * 0.5f, BackdropZ + depth * 0.5f);
                ceilingQuad.localScale = new Vector3(width, depth, 1f);
            }
        }

        /// <summary>Reflects a [scale, offset] UV window about its own centre.</summary>
        private static void Mirror(ref float scale, ref float offset)
        {
            float start = offset;
            float end = offset + scale;
            float low = Mathf.Min(start, end);
            float high = Mathf.Max(start, end);
            offset = low + high - offset;
            scale = -scale;
        }

        private void OnVideoFailed(string message)
        {
            Debug.LogWarning($"[Background] {message}. Quay lại background ảnh.");
            ReportAck(false, message);
            StopVideoIfAny();
            CurrentKind = BackgroundKind.Image;
            suppressAck = true;
            try { ApplyImage(lastImageFile, lastImageFit); }
            finally { suppressAck = false; }
        }

        private void OnImageFailed(string message)
        {
            Debug.LogWarning($"[Background] {message}");
            ReportAck(false, message);
            if (restoring) return;

            if (!string.Equals(lastImageFile, LegacyFile, StringComparison.OrdinalIgnoreCase))
            {
                restoring = true;
                ApplyImage(LegacyFile, BackgroundFitMode.Native);
                restoring = false;
                return;
            }

            CurrentKind = BackgroundKind.Image;
            CurrentFile = LegacyFile;
            CurrentFit = BackgroundFitMode.Native;
        }

        private void StopVideoIfAny()
        {
            if (videoSource == null) return;
            if (CurrentKind == BackgroundKind.Video) activeTexture = null;
            videoSource.StopVideo();
        }

        /// <summary>
        /// Tells the panel what really happened: applied (with the real size of
        /// what is on screen) or failed with a reason, so the UI never claims
        /// success before the texture is live.
        /// </summary>
        private void ReportAck(bool ok, string error, int width = 0, int height = 0, double duration = 0d)
        {
            if (suppressAck) return;
            if (ackClient == null) ackClient = FindFirstObjectByType<TikTokWebSocketClient>();
            if (ackClient == null) return;
            ackClient.SendBackgroundAck(CurrentFile, pendingGeneration, ok, error, width, height, duration);
        }

        /// <summary>Only the four orientations a video file can declare are honoured.</summary>
        private static int NormalizeRotation(int degrees)
        {
            int normalized = ((degrees % 360) + 360) % 360;
            return normalized is 90 or 180 or 270 ? normalized : 0;
        }

        private static BackgroundFitMode ParseFit(string fitMode)
        {
            if (string.IsNullOrWhiteSpace(fitMode)) return BackgroundFitMode.Native;
            return fitMode.Trim().ToLowerInvariant() switch
            {
                "fit" or "contain" => BackgroundFitMode.Fit,
                "fill" or "cover" => BackgroundFitMode.Fill,
                _ => BackgroundFitMode.Native
            };
        }

        /// <summary>
        /// Finds the media next to the build. Videos live in DJ_VIDEO in this
        /// project (that is where the operator drops clips), so that folder is
        /// searched first and the HTTP fallback is only used when nothing local
        /// matches.
        /// </summary>
        private bool TryResolveLocal(string file, string folder, out string path)
        {
            bool isVideo = folder == "videos";
            foreach (string root in RootFolders())
            {
                string[] candidates = isVideo
                    ? new[]
                    {
                        Path.Combine(root, "DJ_VIDEO", file),
                        Path.Combine(root, "LiveAssets", "Backgrounds", "videos", file),
                        Path.Combine(root, "LiveAssets", file)
                    }
                    : new[]
                    {
                        Path.Combine(root, "LiveAssets", "Backgrounds", "images", file),
                        Path.Combine(root, "LiveAssets", file),
                        Path.Combine(root, "DJ_VIDEO", file)
                    };

                foreach (string candidate in candidates)
                {
                    if (!File.Exists(candidate)) continue;
                    path = candidate;
                    return true;
                }
            }

            path = null;
            return false;
        }

        private static string[] RootFolders()
        {
            string buildRoot = Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;
            string projectRoot = Directory.GetParent(buildRoot)?.FullName ?? buildRoot;
            string workspaceRoot = Directory.GetParent(projectRoot)?.FullName ?? projectRoot;
            string workingFolder = Directory.GetCurrentDirectory();
            string workingParent = Directory.GetParent(workingFolder)?.FullName ?? workingFolder;
            return new[] { buildRoot, projectRoot, workspaceRoot, workingFolder, workingParent };
        }

        private string ResolveHttpUrl(string file, string folder)
        {
            string serverUrl = resolvedServerUrl;
            if (string.IsNullOrEmpty(serverUrl))
            {
                TikTokWebSocketClient client = FindFirstObjectByType<TikTokWebSocketClient>();
                serverUrl = client != null ? client.ServerUrl : "ws://127.0.0.1:3000";
                resolvedServerUrl = serverUrl;
            }

            string httpBase = serverUrl
                .Replace("wss://", "https://", StringComparison.OrdinalIgnoreCase)
                .Replace("ws://", "http://", StringComparison.OrdinalIgnoreCase)
                .TrimEnd('/');

            return $"{httpBase}/backgrounds/{folder}/{Uri.EscapeDataString(file)}";
        }
    }
}
