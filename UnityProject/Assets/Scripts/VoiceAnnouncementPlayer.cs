using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

namespace TikTokLiveGame
{
    /// <summary>
    /// Plays the bridge's English MC announcements through a dedicated 2D source.
    /// The DJ playlist keeps its own AudioSource; this component only asks
    /// MusicPlaylistPlayer to lower its volume while speech is audible.
    /// </summary>
    public sealed class VoiceAnnouncementPlayer : MonoBehaviour
    {
        private const int MaxPending = 8;
        private const int RecentIdLimit = 32;

        private readonly Queue<TikTokEvent> pending = new();
        private readonly HashSet<string> recentIds = new();
        private readonly Queue<string> recentOrder = new();

        private TikTokWebSocketClient client;
        private MusicPlaylistPlayer music;
        private AudioSource voiceSource;
        private AudioClip activeClip;
        private UnityWebRequest activeRequest;
        private Coroutine playbackRoutine;
        private bool busy;
        private bool stopRequested;

        private string playbackState = "idle";
        private string lastDownloadError = string.Empty;
        private string lastPlaybackError = string.Empty;
        private string activeProvider = string.Empty;
        private string activeVoice = string.Empty;
        private float activeLufs;
        private float activeTruePeakDb;
        private float activePeakDb;
        private float activeRmsDb;
        private int activeSampleRate;
        private int activeChannels;
        private int activeBits;
        private float activeDuckLevel = 0.18f;
        private float activeDuckAttackMs = 180f;
        private float activeDuckReleaseMs = 450f;
        private float nextDiagnosticsAt;

        private void Awake()
        {
            voiceSource = gameObject.AddComponent<AudioSource>();
            voiceSource.playOnAwake = false;
            voiceSource.loop = false;
            voiceSource.spatialBlend = 0f; // 2D, independent of camera/player position.
            voiceSource.pitch = 1f;
            voiceSource.volume = 0f;
            voiceSource.priority = 32;
            voiceSource.mute = false;
            voiceSource.bypassReverbZones = true;
            voiceSource.ignoreListenerPause = true;
            // Keep this source on the master mix; there are no hidden mixer groups
            // in this project, and an accidental group attenuation would be visible
            // in the diagnostics panel.
            voiceSource.outputAudioMixerGroup = null;
        }

        public void Initialize(TikTokWebSocketClient socketClient, MusicPlaylistPlayer musicPlayer)
        {
            if (client == socketClient) return;
            if (client != null) client.EventReceived -= HandleEvent;
            client = socketClient;
            music = musicPlayer;
            if (client != null) client.EventReceived += HandleEvent;
            ReportDiagnostics();
        }

        private void HandleEvent(TikTokEvent liveEvent)
        {
            if (liveEvent == null) return;
            if (liveEvent.type == "voice_control" && liveEvent.action == "stop")
            {
                StopCurrent();
                return;
            }
            if (liveEvent.type != "voice_announcement") return;
            if (string.IsNullOrWhiteSpace(liveEvent.id) || string.IsNullOrWhiteSpace(liveEvent.url))
            {
                lastPlaybackError = "Announcement had no id or audio URL.";
                playbackState = "error";
                client?.VoiceAck(liveEvent.id ?? string.Empty, false, lastPlaybackError);
                ReportDiagnostics();
                return;
            }
            if (recentIds.Contains(liveEvent.id)) return;

            pending.Enqueue(liveEvent);
            while (pending.Count > MaxPending) pending.Dequeue();
        }

        private void Update()
        {
            if (!busy && pending.Count > 0)
            {
                TikTokEvent announcement = pending.Dequeue();
                busy = true;
                stopRequested = false;
                playbackRoutine = StartCoroutine(PlayAnnouncement(announcement));
            }

            // The panel needs the actual live values, not a bridge-side guess.
            // Once per second is enough and keeps WebSocket traffic bounded.
            if (Time.unscaledTime >= nextDiagnosticsAt)
            {
                nextDiagnosticsAt = Time.unscaledTime + 1f;
                ReportDiagnostics();
            }
        }

        private System.Collections.IEnumerator PlayAnnouncement(TikTokEvent announcement)
        {
            string id = announcement.id;
            MarkRecent(id);
            playbackState = "downloading";
            lastDownloadError = string.Empty;
            lastPlaybackError = string.Empty;
            activeProvider = announcement.provider ?? string.Empty;
            activeVoice = announcement.voice ?? string.Empty;
            activeLufs = announcement.lufs;
            activeTruePeakDb = announcement.truePeakDb;
            activePeakDb = announcement.peakDb;
            activeRmsDb = announcement.rmsDb;
            activeSampleRate = announcement.sampleRate;
            activeChannels = announcement.channels;
            activeBits = announcement.bits;
            activeDuckLevel = Mathf.Clamp(announcement.duckLevel, 0.02f, 1f);
            activeDuckAttackMs = Mathf.Clamp(announcement.duckAttackMs, 40f, 2000f);
            activeDuckReleaseMs = Mathf.Clamp(announcement.duckReleaseMs, 40f, 2000f);
            ReportDiagnostics();

            string uri = ResolveAudioUrl(announcement.url);
            activeRequest = UnityWebRequestMultimedia.GetAudioClip(uri, AudioType.WAV);
            activeRequest.timeout = 15;
            yield return activeRequest.SendWebRequest();

            if (stopRequested)
            {
                FinishPlayback(activeDuckReleaseMs);
                yield break;
            }

            if (activeRequest.result != UnityWebRequest.Result.Success)
            {
                lastDownloadError = $"Voice WAV download failed ({activeRequest.responseCode}): {activeRequest.error}";
                playbackState = "error";
                Debug.LogWarning($"[Voice] {lastDownloadError}");
                client?.VoiceAck(id, false, lastDownloadError);
                ReportDiagnostics();
                FinishPlayback(activeDuckReleaseMs);
                yield break;
            }

            AudioClip clip = DownloadHandlerAudioClip.GetContent(activeRequest);
            activeRequest.Dispose();
            activeRequest = null;

            if (clip == null)
            {
                lastPlaybackError = "Unity could not decode the voice WAV.";
                playbackState = "error";
                client?.VoiceAck(id, false, lastPlaybackError);
                ReportDiagnostics();
                FinishPlayback(activeDuckReleaseMs);
                yield break;
            }

            if (stopRequested)
            {
                Destroy(clip);
                FinishPlayback(activeDuckReleaseMs);
                yield break;
            }

            activeClip = clip;
            voiceSource.clip = clip;
            // The bridge already applied LUFS normalization, output gain and the
            // true-peak limiter before caching this WAV. This is the only Unity
            // gain stage; applying dB here would double-process the voice.
            voiceSource.volume = Mathf.Clamp01(announcement.volume);
            voiceSource.pitch = 1f;
            voiceSource.mute = false;
            if (music != null)
                music.DuckForVoice(activeDuckLevel, activeDuckAttackMs, activeDuckReleaseMs);
            voiceSource.Play();
            playbackState = "playing";
            client?.VoiceAck(id, true);
            ReportDiagnostics();
            Debug.Log($"[Voice] Playing {announcement.categoryLabel} ({announcement.provider}/{announcement.voice}) " +
                      $"duration={clip.length:0.00}s sourceVolume={voiceSource.volume:0.00} " +
                      $"spatialBlend={voiceSource.spatialBlend:0.00} pitch={voiceSource.pitch:0.00} " +
                      $"listenerVolume={AudioListener.volume:0.00} duck={activeDuckLevel:0.00} " +
                      $"attack={activeDuckAttackMs:0} release={activeDuckReleaseMs:0} " +
                      $"lufs={activeLufs:0.0} truePeak={activeTruePeakDb:0.0} text='{announcement.text}'");

            while (voiceSource != null && voiceSource.isPlaying && !stopRequested)
                yield return null;

            if (voiceSource != null) voiceSource.Stop();
            FinishPlayback(activeDuckReleaseMs);
        }

        private void FinishPlayback(float releaseMs)
        {
            if (voiceSource != null)
            {
                voiceSource.Stop();
                voiceSource.clip = null;
            }
            if (activeClip != null)
            {
                Destroy(activeClip);
                activeClip = null;
            }
            if (activeRequest != null)
            {
                activeRequest.Dispose();
                activeRequest = null;
            }
            if (music != null) music.RestoreMusicAfterVoice(releaseMs);
            playbackState = lastDownloadError.Length > 0 || lastPlaybackError.Length > 0 ? "error" : "idle";
            playbackRoutine = null;
            busy = false;
            stopRequested = false;
            ReportDiagnostics();
        }

        private void ReportDiagnostics()
        {
            AudioListener[] listeners = FindObjectsByType<AudioListener>(FindObjectsSortMode.None);
            string mixerGroup = voiceSource != null && voiceSource.outputAudioMixerGroup != null
                ? voiceSource.outputAudioMixerGroup.name
                : "Master";
            client?.VoiceDiagnostics(
                playbackState,
                activeProvider,
                activeVoice,
                voiceSource != null ? voiceSource.volume : 0f,
                voiceSource != null ? voiceSource.spatialBlend : 0f,
                voiceSource != null ? voiceSource.pitch : 1f,
                voiceSource != null && voiceSource.mute,
                music != null ? music.CurrentVolume : 0f,
                music != null ? music.DuckMultiplier : 1f,
                music != null && music.DuckingActive,
                activeDuckLevel,
                activeDuckAttackMs,
                activeDuckReleaseMs,
                AudioListener.volume,
                listeners.Length,
                mixerGroup,
                activeLufs,
                activeTruePeakDb,
                activePeakDb,
                activeRmsDb,
                activeSampleRate,
                activeChannels,
                activeBits,
                lastDownloadError,
                lastPlaybackError);
        }

        /// <summary>Stops the current voice only; the DJ playlist is never stopped.</summary>
        public void StopCurrent()
        {
            stopRequested = true;
            if (activeRequest != null) activeRequest.Abort();
            if (voiceSource != null) voiceSource.Stop();
            if (playbackRoutine == null)
                FinishPlayback(activeDuckReleaseMs);
        }

        private string ResolveAudioUrl(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return string.Empty;
            if (path.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                path.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                return path;
            string server = client != null ? client.ServerUrl : "ws://127.0.0.1:3000";
            server = server.Replace("ws://", "http://", StringComparison.OrdinalIgnoreCase)
                .Replace("wss://", "https://", StringComparison.OrdinalIgnoreCase)
                .TrimEnd('/');
            return server + (path.StartsWith("/", StringComparison.Ordinal) ? path : "/" + path);
        }

        private void MarkRecent(string id)
        {
            if (!recentIds.Add(id)) return;
            recentOrder.Enqueue(id);
            while (recentOrder.Count > RecentIdLimit)
                recentIds.Remove(recentOrder.Dequeue());
        }

        private void OnDestroy()
        {
            if (client != null) client.EventReceived -= HandleEvent;
            if (playbackRoutine != null) StopCoroutine(playbackRoutine);
            if (activeRequest != null)
            {
                activeRequest.Abort();
                activeRequest.Dispose();
                activeRequest = null;
            }
            if (activeClip != null) Destroy(activeClip);
            if (voiceSource != null)
            {
                voiceSource.Stop();
                voiceSource.clip = null;
            }
            if (music != null) music.RestoreMusicAfterVoice(200f);
            pending.Clear();
            recentIds.Clear();
            recentOrder.Clear();
        }
    }
}
