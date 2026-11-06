using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.Networking;

namespace TikTokLiveGame
{
    /// <summary>
    /// Background DJ playlist.
    /// Scans DJ_MUSIC next to the game build (and at the repository root when running from the
    /// editor), decodes MP3/WAV/OGG through UnityWebRequest and plays the files in filename
    /// order, wrapping back to the first track at the end of the list.
    /// The folder is polled every few seconds, so files copied in (or removed) while the game is
    /// running are picked up automatically, and VOLUME.txt is re-read when it changes.
    /// Playback is independent from the TikTok connection, so a WebSocket reconnect never
    /// interrupts the music.
    /// </summary>
    public sealed class MusicPlaylistPlayer : MonoBehaviour
    {
        private const float DefaultVolume = 0.35f;
        private const float FadeSeconds = 1.2f;
        private const float RescanSeconds = 4f;
        private const string LegacyMusicFolder = @"D:\TIKTOK_LIVE_BAR\DJ_MUSIC";

        private static readonly string[] SupportedExtensions = { ".mp3", ".wav", ".ogg" };

        private AudioSource output;
        private AudioClip currentClip;
        private string[] tracks = Array.Empty<string>();
        private string musicFolder = string.Empty;
        private int trackIndex;
        private float configuredVolume = DefaultVolume;
        private float trackStartedAt;
        private float watchdogAt;
        private float advanceAt;
        private float nextRescanAt;
        private DateTime volumeWriteTime = DateTime.MinValue;
        private bool loading;
        private bool advancePending;
        private bool wasPlaying;
        private bool playConfirmed;

        private void Awake()
        {
            LogAudioEnvironment();
            tracks = FindTracks(out musicFolder, verbose: true);
            if (tracks.Length == 0)
            {
                // Stay enabled: the rescan loop below starts the music as soon as a file appears,
                // so nothing has to be restarted after copying music into DJ_MUSIC.
                Debug.LogWarning($"[Music] No MP3/WAV/OGG found yet. Put your music files in: {PrimaryMusicFolder()} " +
                                 $"(the folder is re-checked every {RescanSeconds:0}s, no restart needed).");
                nextRescanAt = Time.unscaledTime + RescanSeconds;
                return;
            }

            StartPlaylist();
        }

        private void StartPlaylist()
        {
            configuredVolume = ReadVolume(musicFolder);
            if (output == null)
            {
                output = gameObject.AddComponent<AudioSource>();
                output.playOnAwake = false;
                output.loop = false;
                output.spatialBlend = 0f; // 2D: identical on both speakers, no distance falloff.
                output.volume = 0f;
                output.priority = 128;
            }
            output.mute = false;
            Debug.Log($"[Music] Playlist ready: {tracks.Length} track(s) from '{musicFolder}', volume {configuredVolume:0.00}.");
            PlayTrack(0);
        }

        private void Update()
        {
            if (output == null)
            {
                if (Time.unscaledTime >= nextRescanAt)
                {
                    nextRescanAt = Time.unscaledTime + RescanSeconds;
                    tracks = FindTracks(out musicFolder, verbose: false);
                    if (tracks.Length > 0)
                    {
                        Debug.Log($"[Music] Detected {tracks.Length} track(s) in '{musicFolder}' after rescan; starting playback.");
                        StartPlaylist();
                    }
                }
                return;
            }

            if (Time.unscaledTime >= nextRescanAt)
            {
                nextRescanAt = Time.unscaledTime + RescanSeconds;
                RefreshPlaylist();
            }

            if (advancePending && Time.unscaledTime >= advanceAt)
            {
                advancePending = false;
                PlayTrack((trackIndex + 1) % tracks.Length);
                return;
            }

            if (output.isPlaying)
            {
                wasPlaying = true;
                float fadeIn = Mathf.Clamp01((Time.unscaledTime - trackStartedAt) / FadeSeconds);
                float length = currentClip != null ? currentClip.length : 0f;
                // Some decoders (notably streamed MP3) report length 0 until the clip is fully
                // decoded. Treat an unknown length as "no fade out yet" instead of muting the
                // clip forever with a negative remaining time.
                float fadeOut = length > 0.05f
                    ? Mathf.Clamp01((length - output.time) / FadeSeconds)
                    : 1f;
                output.volume = configuredVolume * Mathf.Min(fadeIn, fadeOut);
                watchdogAt = Time.unscaledTime + 3f;

                if (!playConfirmed && output.time > 0.25f)
                {
                    playConfirmed = true;
                    Debug.Log($"[Music] Playback confirmed: '{Path.GetFileName(tracks[trackIndex])}' " +
                              $"time={output.time:0.00}s length={(length > 0.05f ? length.ToString("0.0") : "?")}s " +
                              $"volume={output.volume:0.00} source.isPlaying={output.isPlaying}");
                }
            }
            else if (wasPlaying && !loading)
            {
                wasPlaying = false;
                output.volume = 0f;
                Debug.Log($"[Music] Finished '{Path.GetFileName(tracks[trackIndex])}' after {output.time:0.0}s; next track follows.");
                ScheduleAdvance(0.05f);
            }
            else if (!loading && !advancePending && Time.unscaledTime >= watchdogAt)
            {
                Debug.LogWarning($"[Music] Watchdog: '{Path.GetFileName(tracks[trackIndex])}' is not playing " +
                                 $"(isPlaying={output.isPlaying}, time={output.time:0.00}s, clip={(currentClip == null ? "null" : currentClip.length.ToString("0.0") + "s")}); advancing.");
                ScheduleAdvance(0.5f);
            }
        }

        /// <summary>
        /// Re-reads DJ_MUSIC while the game is running: added/removed files rebuild the playlist
        /// without interrupting the song that is currently audible, and VOLUME.txt is re-applied
        /// when it changes.
        /// </summary>
        private void RefreshPlaylist()
        {
            string[] found = ScanFolder(musicFolder);
            if (found.Length == 0)
            {
                if (tracks.Length > 0)
                {
                    Debug.LogWarning($"[Music] '{musicFolder}' is now empty or missing; keeping the current track and retrying.");
                    nextRescanAt = Time.unscaledTime + RescanSeconds;
                }
                return;
            }

            bool volumeChanged = ReapplyVolumeIfChanged();
            if (found.Length == tracks.Length && !found.Where((file, index) => !string.Equals(file, tracks[index], StringComparison.OrdinalIgnoreCase)).Any())
            {
                if (volumeChanged) Debug.Log($"[Music] Volume re-applied: {configuredVolume:0.00}.");
                return;
            }

            string playing = tracks.Length > 0 && trackIndex < tracks.Length ? tracks[trackIndex] : string.Empty;
            tracks = found;
            int newIndex = Array.FindIndex(tracks, file => string.Equals(file, playing, StringComparison.OrdinalIgnoreCase));
            Debug.Log($"[Music] DJ_MUSIC changed: {tracks.Length} track(s) now considered. " +
                      $"Files: {string.Join(", ", tracks.Select(Path.GetFileName))}");
            if (newIndex >= 0)
            {
                trackIndex = newIndex;
                if (volumeChanged && output != null) output.volume = Mathf.Min(output.volume, configuredVolume);
                return; // Keep the audible song running.
            }

            Debug.Log("[Music] The playing file is gone; switching to the first track of the new list.");
            advancePending = false;
            PlayTrack(0);
        }

        private bool ReapplyVolumeIfChanged()
        {
            string path = Path.Combine(musicFolder, "VOLUME.txt");
            if (!File.Exists(path)) return false;
            DateTime writeTime = File.GetLastWriteTimeUtc(path);
            if (writeTime == volumeWriteTime) return false;
            volumeWriteTime = writeTime;
            float volume = ReadVolume(musicFolder);
            if (Mathf.Abs(volume - configuredVolume) < 0.001f) return false;
            configuredVolume = volume;
            return true;
        }

        private void PlayTrack(int index)
        {
            if (tracks.Length == 0) return;
            trackIndex = Mathf.Clamp(index, 0, tracks.Length - 1);
            StopCurrentClip();
            loading = true;
            advancePending = false;
            playConfirmed = false;
            watchdogAt = Time.unscaledTime + 20f;
            StartCoroutine(LoadAndPlay(tracks[trackIndex]));
        }

        private IEnumerator LoadAndPlay(string path)
        {
            AudioType type = AudioTypeFor(path);
            string extension = Path.GetExtension(path).ToLowerInvariant();
            string uri = new Uri(path).AbsoluteUri;
            long size = -1;
            try { size = new FileInfo(path).Length; } catch (Exception error) { Debug.LogWarning($"[Music] Cannot stat '{path}': {error.Message}"); }

            Debug.Log($"[Music] Loading {trackIndex + 1}/{tracks.Length}: '{path}' " +
                      $"(type={type}, ext={extension}, size={(size >= 0 ? (size / 1024) + " KB" : "unknown")})");

            using UnityWebRequest request = UnityWebRequestMultimedia.GetAudioClip(uri, type);
            if (request.downloadHandler is DownloadHandlerAudioClip audioDownload)
                // Local files are small enough to decode up front: a fully decoded clip has a
                // correct length and cannot stall the fade/advance logic.
                audioDownload.streamAudio = false;
            yield return request.SendWebRequest();

            loading = false;
            if (request.result != UnityWebRequest.Result.Success)
            {
                Debug.LogWarning($"[Music] DECODE FAILED '{path}': result={request.result}, " +
                                 $"http={request.responseCode}, error='{request.error}'. " +
                                 (extension == ".mp3" ? "Re-export the file as MP3/CBR or convert it to WAV/OGG." : "File may be corrupted or unsupported."));
                ScheduleAdvance(tracks.Length == 1 ? 2f : 0.75f);
                yield break;
            }

            currentClip = DownloadHandlerAudioClip.GetContent(request);
            if (currentClip == null)
            {
                Debug.LogWarning($"[Music] DECODE RETURNED NULL for '{path}'.");
                ScheduleAdvance(tracks.Length == 1 ? 2f : 0.75f);
                yield break;
            }

            Debug.Log($"[Music] Decoded '{Path.GetFileName(path)}': channels={currentClip.channels}, " +
                      $"frequency={currentClip.frequency} Hz, length={currentClip.length:0.00}s, samples={currentClip.samples}");

            currentClip.name = $"Music {Path.GetFileName(path)}";
            output.clip = currentClip;
            output.volume = 0f;
            output.mute = false;
            trackStartedAt = Time.unscaledTime;
            watchdogAt = Time.unscaledTime + 5f;
            output.Play();
            Debug.Log($"[Music] Music playing {trackIndex + 1}/{tracks.Length}: {path} " +
                      $"(source.isPlaying={output.isPlaying}, targetVolume={configuredVolume:0.00})");
        }

        private void StopCurrentClip()
        {
            if (output != null)
            {
                output.Stop();
                output.clip = null;
                output.volume = 0f;
            }
            if (currentClip != null) Destroy(currentClip);
            currentClip = null;
            wasPlaying = false;
        }

        private void ScheduleAdvance(float delay)
        {
            if (advancePending) return;
            advancePending = true;
            advanceAt = Time.unscaledTime + Mathf.Max(0.05f, delay);
        }

        private static AudioType AudioTypeFor(string path)
        {
            return Path.GetExtension(path).ToLowerInvariant() switch
            {
                ".wav" => AudioType.WAV,
                ".ogg" => AudioType.OGGVORBIS,
                _ => AudioType.MPEG
            };
        }

        /// <summary>Folder the player prefers, used for the "put your files here" message.</summary>
        private static string PrimaryMusicFolder()
        {
            return Path.Combine(RootFolders().ProjectRoot, "DJ_MUSIC");
        }

        private static (string BuildRoot, string ProjectRoot, string WorkspaceRoot) RootFolders()
        {
            string buildRoot = Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;
            string projectRoot = Directory.GetParent(buildRoot)?.FullName ?? buildRoot;
            string workspaceRoot = Directory.GetParent(projectRoot)?.FullName ?? projectRoot;
            return (buildRoot, projectRoot, workspaceRoot);
        }

        private static IEnumerable<string> MusicFolders()
        {
            (string buildRoot, string projectRoot, string workspaceRoot) = RootFolders();
            string workingFolder = Directory.GetCurrentDirectory();
            string workingParent = Directory.GetParent(workingFolder)?.FullName ?? workingFolder;

            // Order matters: the first folder that contains audio wins.
            // ProjectRoot is the repository root in both the editor (<repo>\UnityProject\Assets)
            // and the built player (<repo>\Build\OngChuMMO_Live_Data), so <repo>\DJ_MUSIC works
            // for both.
            yield return Path.Combine(projectRoot, "DJ_MUSIC");
            yield return Path.Combine(buildRoot, "DJ_MUSIC");
            yield return Path.Combine(workingFolder, "DJ_MUSIC");
            yield return Path.Combine(workingParent, "DJ_MUSIC");
            yield return Path.Combine(workspaceRoot, "DJ_MUSIC");
            yield return Path.Combine(workspaceRoot, "assets", "music");
            yield return Application.streamingAssetsPath;
            yield return LegacyMusicFolder;
        }

        private static string[] ScanFolder(string folder)
        {
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return Array.Empty<string>();
            try
            {
                return Directory.EnumerateFiles(folder)
                    .Where(file => SupportedExtensions.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase))
                    .OrderBy(file => Path.GetFileName(file), StringComparer.OrdinalIgnoreCase)
                    .ToArray();
            }
            catch (Exception error)
            {
                Debug.LogWarning($"[Music] Cannot read '{folder}': {error.Message}");
                return Array.Empty<string>();
            }
        }

        private static string[] FindTracks(out string selectedFolder, bool verbose)
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var scanned = new List<string>();
            if (verbose) Debug.Log("[Music] Searching for music folders:");
            foreach (string candidate in MusicFolders())
            {
                string folder;
                try { folder = Path.GetFullPath(candidate); }
                catch { continue; }
                if (!seen.Add(folder)) continue;
                scanned.Add(folder);

                string[] files = ScanFolder(folder);
                if (verbose)
                {
                    Debug.Log($"[Music]   {(Directory.Exists(folder) ? (files.Length > 0 ? "[FOUND]" : "[empty]") : "[missing]")} {folder}" +
                              (files.Length > 0 ? $" -> {files.Length} audio file(s)" : string.Empty));
                }

                if (files.Length == 0) continue;

                selectedFolder = folder;
                if (verbose)
                {
                    foreach (string file in files)
                    {
                        long size = -1;
                        try { size = new FileInfo(file).Length; } catch { /* reported at load time */ }
                        Debug.Log($"[Music]     - {Path.GetFileName(file)} ({(size >= 0 ? (size / 1024) + " KB" : "unknown size")})");
                    }
                }
                return files;
            }
            if (verbose) Debug.Log("[Music] No audio files in any searched folder: " + string.Join(" | ", scanned));
            selectedFolder = string.Empty;
            return Array.Empty<string>();
        }

        private static void LogAudioEnvironment()
        {
            AudioListener[] listeners = UnityEngine.Object.FindObjectsByType<AudioListener>(FindObjectsSortMode.None);
            AudioSettings.GetDSPBufferSize(out int bufferLength, out int bufferCount);
            Debug.Log($"[Music] Audio environment: listeners={listeners.Length}, " +
                      $"globalListenerVolume={AudioListener.volume:0.00}, " +
                      $"sampleRate={AudioSettings.outputSampleRate} Hz, " +
                      $"speakerMode={AudioSettings.speakerMode}, dspBuffer={bufferLength}x{bufferCount}");
            if (listeners.Length == 0)
                Debug.LogWarning("[Music] No AudioListener in the scene - decoded music will have nowhere to output.");
        }

        private static float ReadVolume(string folder)
        {
            if (string.IsNullOrEmpty(folder)) return DefaultVolume;
            var candidates = new List<string> { Path.Combine(folder, "VOLUME.txt") };
            string primary = Path.Combine(PrimaryMusicFolder(), "VOLUME.txt");
            if (!candidates.Contains(primary, StringComparer.OrdinalIgnoreCase)) candidates.Add(primary);

            foreach (string path in candidates)
            {
                if (!File.Exists(path)) continue;
                string value = File.ReadAllText(path).Trim().Replace(',', '.');
                if (!float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out float parsed))
                {
                    Debug.LogWarning($"[Music] VOLUME.txt at '{path}' is not a number ('{value}'); using {DefaultVolume:0.00}.");
                    return DefaultVolume;
                }
                if (parsed > 1f) parsed /= 100f;
                parsed = Mathf.Clamp01(parsed);
                Debug.Log($"[Music] Volume from '{path}': {parsed:0.00}");
                return parsed;
            }
            Debug.Log($"[Music] No VOLUME.txt found; using default volume {DefaultVolume:0.00}.");
            return DefaultVolume;
        }

        private void OnDestroy()
        {
            StopAllCoroutines();
            StopCurrentClip();
        }
    }
}
