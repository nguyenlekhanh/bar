using UnityEngine;

namespace TikTokLiveGame
{
    [RequireComponent(typeof(SpriteRenderer))]
    public sealed class SpriteFlipbook : MonoBehaviour
    {
        private SpriteRenderer target;
        private Sprite[] frames = System.Array.Empty<Sprite>();
        private float framesPerSecond = 12f;
        private float playbackSpeed = 1f;
        private bool loop = true;
        private float clock;
        private int frameIndex;

        private void Awake() => target = GetComponent<SpriteRenderer>();

        public void SetFrames(Sprite[] nextFrames, float fps = 12f)
        {
            frames = nextFrames ?? System.Array.Empty<Sprite>();
            framesPerSecond = Mathf.Max(1f, fps);
            clock = Random.value / framesPerSecond;
            frameIndex = 0;
            target.sprite = frames.Length > 0 ? frames[0] : null;
        }

        public void SetPlaybackSpeed(float speed)
        {
            playbackSpeed = Mathf.Clamp(speed, 0.5f, 3f);
        }

        /// <summary>Non-looping animations hold their last frame instead of wrapping.</summary>
        public void SetLoop(bool shouldLoop) => loop = shouldLoop;

        /// <summary>Restarts playback from the first frame.</summary>
        public void ResetPlayback()
        {
            clock = 0f;
            frameIndex = 0;
            if (target != null) target.sprite = frames.Length > 0 ? frames[0] : null;
        }

        private void Update()
        {
            if (frames.Length < 2) return;
            clock += Time.deltaTime * playbackSpeed;
            float frameDuration = 1f / framesPerSecond;
            while (clock >= frameDuration)
            {
                clock -= frameDuration;
                if (!loop && frameIndex == frames.Length - 1)
                {
                    clock = 0f;
                    break;
                }
                frameIndex = (frameIndex + 1) % frames.Length;
                target.sprite = frames[frameIndex];
            }
        }
    }
}
