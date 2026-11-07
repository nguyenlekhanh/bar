using System;

namespace TikTokLiveGame
{
    [Serializable]
    public class TikTokEvent
    {
        public string type;
        public string state;
        public string message;
        public string userId;
        public string uniqueId;
        public string nickname;
        public string avatar;
        public string comment;
        public string giftId;
        public string giftName;
        public string action;
        public string masterRuleId;
        public string label;
        public string variant;
        public string titleLabel;
        public string titleVariant;
        public int repeatCount;
        public int diamondCount;
        public int likeCount;
        public int score;
        public int giftPower;
        public int durationMs;
        public int fireworkBursts;
        // Gift → animation mapping resolved by the bridge. `animationEffect` is
        // an allow-listed effect name, never a file or resource path.
        public string animationId;
        public string animationEffect;
        public string animationCharacter;
        public string eventId;
        // Voice announcements are JSON metadata only; the WAV is downloaded from
        // the loopback bridge into a dedicated 2D AudioSource.
        public string id;
        public string url;
        public string text;
        public string category;
        public string categoryLabel;
        public string voice;
        public string provider;
        public float volume = 1f;
        public float duckLevel = 0.18f;
        public float duckFadeMs = 350f;
        public string[] userIds;
        public int animationDurationMs;
        public bool spectatorOnly;
        public bool joinedNow;
        public long titleExpiresAt;
        public TikTokPlayerData[] players;
        public TikTokPlayerData[] vipScores;
        public BackgroundConfigPayload background;
    }

    [Serializable]
    public class BackgroundTransformPayload
    {
        public int rotation;
        public bool flipHorizontal;
        public bool flipVertical;
    }

    [Serializable]
    public class BackgroundConfigPayload
    {
        public string id;
        public string type;
        public string file;
        public string fitMode;
        public bool loop;
        public int rotation;
        public BackgroundTransformPayload transform;
        public int generation;
    }

    [Serializable]
    public class TikTokPlayerData
    {
        public string userId;
        public string uniqueId;
        public string nickname;
        public string avatar;
        public string titleLabel;
        public string titleVariant;
        public int score;
        public int giftPower;
        public long titleExpiresAt;
    }

    [Serializable]
    internal class ClientMessage
    {
        public string type;
        public string role;
        public string username;
        public string action;
        public string giftName;
        public string eventId;
        public string animationId;
        public string file;
        public string id;
        public int count;
        public int userIndex;
        public int value;
        public int generation;
        public bool ok;
        public string error;
        public int width;
        public int height;
        public double duration;
    }
}
