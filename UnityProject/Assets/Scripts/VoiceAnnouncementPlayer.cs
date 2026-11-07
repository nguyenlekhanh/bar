using System;
using System.Collections.Generic;
using System.IO;
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

        private void Awake()
        {
            voiceSource = gameObject.AddComponent<AudioSource>();
            voiceSource.playOnAwake = false;
            voiceSource.loop = false;
            voiceSource.spatialBlend = 0f; // 2D, included in the same game audio mix as the DJ.
            voiceSource.volume = 0f;
            voiceSource.priority = 32;
            voiceSource.mute = false;
            voiceSource.ignoreListenerPause = true;
        }

        public void Initialize(TikTokWebSocketClient socketClient, MusicPlaylistPlayer musicPlayer)
        {
            if (client == socketClient) return;
            if (client != null) client.EventReceived -= HandleEvent;
            client = socketClient;
            music = musicPlayer;
            if (client != null) client.EventReceived += HandleEvent;
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
                client?.VoiceAck(liveEvent.id ?? string.Empty, false, "Announcement had no id or audio URL.");
                return;
            }
            if (recentIds.Contains(liveEvent.id)) return;

            pending.Enqueue(liveEvent);
            while (pending.Count > MaxPending) pending.Dequeue();
        }

        private void Update()
        {
            if (busy || pending.Count == 0) return;
            TikTokEvent announcement = pending.Dequeue();
            busy = true;
            stopRequested = false;
            playbackRoutine = StartCoroutine(PlayAnnouncement(announcement));
        }

        private System.Collections.IEnumerator PlayAnnouncement(TikTokEvent announcement)
        {
            string id = announcement.id;
            MarkRecent(id);
            if (music != null) music.DuckForVoice(announcement.duckLevel, announcement.duckFadeMs);

            string uri = ResolveAudioUrl(announcement.url);
            activeRequest = UnityWebRequestMultimedia.GetAudioClip(uri, AudioType.WAV);
            activeRequest.timeout = 15;
            yield return activeRequest.SendWebRequest();

            if (stopRequested)
            {
                FinishPlayback(announcement.duckFadeMs);
                yield break;
            }

            if (activeRequest.result != UnityWebRequest.Result.Success)
            {
                string error = $"Voice WAV download failed ({activeRequest.responseCode}): {activeRequest.error}";
                Debug.LogWarning($"[Voice] {error}");
                client?.VoiceAck(id, false, error);
                FinishPlayback(announcement.duckFadeMs);
                yield break;
            }

            AudioClip clip = DownloadHandlerAudioClip.GetContent(activeRequest);
            activeRequest.Dispose();
            activeRequest = null;

            if (clip == null)
            {
                client?.VoiceAck(id, false, "Unity could not decode the voice WAV.");
                FinishPlayback(announcement.duckFadeMs);
                yield break;
            }

            activeClip = clip;
            voiceSource.clip = clip;
            voiceSource.volume = Mathf.Clamp01(announcement.volume);
            voiceSource.Play();
            client?.VoiceAck(id, true);
            Debug.Log($"[Voice] Playing {announcement.categoryLabel} ({announcement.provider}/{announcement.voice}) " +
                      $"duration={clip.length:0.00}s text='{announcement.text}'");

            while (voiceSource != null && voiceSource.isPlaying && !stopRequested)
                yield return null;

            if (voiceSource != null) voiceSource.Stop();
            FinishPlayback(announcement.duckFadeMs);
        }

        private void FinishPlayback(float fadeMs)
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
            if (music != null) music.RestoreMusicAfterVoice(fadeMs);
            playbackRoutine = null;
            busy = false;
            stopRequested = false;
        }

        /// <summary>Stops the current voice only; the DJ playlist is never stopped.</summary>
        public void StopCurrent()
        {
            stopRequested = true;
            if (activeRequest != null) activeRequest.Abort();
            if (voiceSource != null) voiceSource.Stop();
            if (playbackRoutine == null)
            {
                FinishPlayback(350f);
            }
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
