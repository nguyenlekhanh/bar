using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace TikTokLiveGame
{
    /// <summary>
    /// Character animation catalogue. Folders that shipped before automatic
    /// discovery are listed as built-ins; everything else comes from the
    /// `Characters/animations.json` manifest the GIF pipeline writes, so a new
    /// animation is usable without editing this file.
    /// </summary>
    public static class CharacterLibrary
    {
        private const string ManifestPath = "Characters/animations";

        private static readonly string[] BuiltInNames =
        {
            "a", "b", "c", "d", "e", "g", "h", "j", "k",
            "mushroom_dance_01", "mushroom_dance_15", "mushroom_magic_02",
            "hanhan_video_dance"
        };

        private static readonly Dictionary<string, Sprite[]> Cache = new();
        private static readonly Dictionary<string, AnimationInfo> Infos = new();
        private static string[] names;

        /// <summary>Every animation that can be used right now.</summary>
        public static string[] Names
        {
            get
            {
                EnsureDiscovered();
                return names;
            }
        }

        public static (string name, Sprite[] frames) RandomCharacter(string except = null)
        {
            string[] choices = Names.Where(name => name != except).ToArray();
            string name = choices[UnityEngine.Random.Range(0, choices.Length)];
            return (name, Load(name));
        }

        /// <summary>Playback rate from the pipeline metadata, or the caller's fallback.</summary>
        public static float FpsFor(string name, float fallback)
        {
            EnsureDiscovered();
            return Infos.TryGetValue(name ?? string.Empty, out AnimationInfo info) && info.fps > 0f
                ? info.fps
                : fallback;
        }

        /// <summary>Whether the source animation should loop; defaults to true.</summary>
        public static bool LoopFor(string name)
        {
            EnsureDiscovered();
            return !Infos.TryGetValue(name ?? string.Empty, out AnimationInfo info) || info.loop;
        }

        /// <summary>Operator playback-speed multiplier from the manifest, default 1.</summary>
        public static float SpeedFor(string name)
        {
            EnsureDiscovered();
            return Infos.TryGetValue(name ?? string.Empty, out AnimationInfo info) && info.playbackSpeed > 0f
                ? info.playbackSpeed
                : 1f;
        }

        /// <summary>Frames for one animation; empty when the folder is gone.</summary>
        public static Sprite[] Frames(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return Array.Empty<Sprite>();
            EnsureDiscovered();
            return Load(name);
        }

        private static Sprite[] Load(string name)
        {
            if (Cache.TryGetValue(name, out Sprite[] cached)) return cached;
            Sprite[] frames = Resources.LoadAll<Sprite>($"Characters/{name}")
                .OrderBy(sprite => sprite.name, StringComparer.Ordinal)
                .ToArray();
            Cache[name] = frames;
            return frames;
        }

        private static void EnsureDiscovered()
        {
            if (names != null) return;

            List<string> discovered = new(BuiltInNames);
            TextAsset manifest = Resources.Load<TextAsset>(ManifestPath);
            if (manifest != null && !string.IsNullOrWhiteSpace(manifest.text))
            {
                try
                {
                    CharacterManifest parsed = JsonUtility.FromJson<CharacterManifest>(manifest.text);
                    foreach (AnimationInfo entry in parsed?.animations ?? Array.Empty<AnimationInfo>())
                    {
                        if (entry == null || string.IsNullOrWhiteSpace(entry.animationId)) continue;
                        if (!discovered.Contains(entry.animationId)) discovered.Add(entry.animationId);
                        Infos[entry.animationId] = entry;
                    }
                }
                catch (Exception error)
                {
                    // A broken manifest must never stop the game from dancing.
                    Debug.LogWarning($"Character animation manifest could not be read: {error.Message}");
                }
            }

            names = discovered.ToArray();
        }

        [Serializable]
        private class CharacterManifest
        {
            public AnimationInfo[] animations;
        }

        [Serializable]
        private class AnimationInfo
        {
            public string animationId;
            public int frameCount;
            public float fps;
            public float playbackSpeed;
            public bool loop;
            public bool transparent;
            public int durationMs;
            public int defaultDurationMs;
        }
    }
}
