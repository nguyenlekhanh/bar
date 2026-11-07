using UnityEngine;

namespace TikTokLiveGame
{
    public static class RuntimeBootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void StartGame()
        {
            if (Object.FindFirstObjectByType<TikTokGameController>() != null) return;
            // TikTok LIVE Studio captures at 60 FPS. Disable display-rate VSync so
            // high-refresh monitors cannot force uneven 60 FPS capture cadence.
            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = 60;
            Application.runInBackground = true;
            // Render at the native vertical stream size so the overlay and
            // scene are not upscaled from a 540x960 backbuffer.
            Screen.SetResolution(1080, 1920, false);
            ClubSceneBuilder.Build();
            StreamViewport.ApplyToCamera(Camera.main);
            CreateLetterboxBackground();

            GameObject root = new("TikTok Live Game");
            AvatarService avatars = root.AddComponent<AvatarService>();
            TikTokWebSocketClient client = root.AddComponent<TikTokWebSocketClient>();
            PlayerManager players = new GameObject("Players").AddComponent<PlayerManager>();
            players.transform.SetParent(root.transform);
            GiftEffectManager giftEffects = root.AddComponent<GiftEffectManager>();
            MusicPlaylistPlayer music = root.AddComponent<MusicPlaylistPlayer>();
            VoiceAnnouncementPlayer voice = root.AddComponent<VoiceAnnouncementPlayer>();
            voice.Initialize(client, music);
            TikTokGameController game = root.AddComponent<TikTokGameController>();
            game.Initialize(client, players, giftEffects);
            LiveInstructionOverlay instructions = root.AddComponent<LiveInstructionOverlay>();
            instructions.Initialize(client);
            VisualCaptureHarness.InstallIfRequested(root);
        }

        private static void CreateLetterboxBackground()
        {
            GameObject backgroundObject = new("Letterbox Background");
            Camera background = backgroundObject.AddComponent<Camera>();
            background.clearFlags = CameraClearFlags.SolidColor;
            background.backgroundColor = Color.black;
            background.cullingMask = 0;
            background.depth = -100f;
            background.orthographic = true;
            background.orthographicSize = 1f;
            background.allowHDR = false;
            background.allowMSAA = false;
            background.useOcclusionCulling = false;
        }
    }
}
