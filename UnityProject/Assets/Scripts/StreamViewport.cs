using UnityEngine;

namespace TikTokLiveGame
{
    /// <summary>
    /// Defines the one portrait frame used by the game camera, TMP overlay and
    /// IMGUI HUD. On a display that is not 9:16 the frame is centered and the
    /// surrounding area is left black instead of stretching the camera.
    /// </summary>
    public static class StreamViewport
    {
        public const float TargetAspect = 9f / 16f;

        public static Vector2Int ContentSize => ContentSizeFor(Screen.width, Screen.height);
        public static Rect PixelRect => PixelRectFor(Screen.width, Screen.height);
        public static Rect NormalizedRect => NormalizedRectFor(Screen.width, Screen.height);

        public static Vector2Int ContentSizeFor(int screenWidth, int screenHeight)
        {
            screenWidth = Mathf.Max(1, screenWidth);
            screenHeight = Mathf.Max(1, screenHeight);
            if (screenWidth / (float)screenHeight > TargetAspect)
            {
                int width = Mathf.Min(screenWidth, Mathf.RoundToInt(screenHeight * TargetAspect));
                return new Vector2Int(Mathf.Max(1, width), screenHeight);
            }

            int height = Mathf.Min(screenHeight, Mathf.RoundToInt(screenWidth / TargetAspect));
            return new Vector2Int(screenWidth, Mathf.Max(1, height));
        }

        /// <summary>Bottom-left based pixel rectangle used by Camera.rect.</summary>
        public static Rect PixelRectFor(int screenWidth, int screenHeight)
        {
            screenWidth = Mathf.Max(1, screenWidth);
            screenHeight = Mathf.Max(1, screenHeight);
            Vector2Int size = ContentSizeFor(screenWidth, screenHeight);
            return new Rect(
                (screenWidth - size.x) * 0.5f,
                (screenHeight - size.y) * 0.5f,
                size.x,
                size.y);
        }

        public static Rect NormalizedRectFor(int screenWidth, int screenHeight)
        {
            screenWidth = Mathf.Max(1, screenWidth);
            screenHeight = Mathf.Max(1, screenHeight);
            Rect pixel = PixelRectFor(screenWidth, screenHeight);
            return new Rect(
                pixel.x / screenWidth,
                pixel.y / screenHeight,
                pixel.width / screenWidth,
                pixel.height / screenHeight);
        }

        public static void ApplyToCamera(Camera camera)
        {
            if (camera == null) return;
            Rect rect = NormalizedRect;
            camera.rect = rect;
            camera.aspect = TargetAspect;
        }

        public static void ApplyFullScreen(Camera camera)
        {
            if (camera == null) return;
            camera.rect = new Rect(0f, 0f, 1f, 1f);
            camera.ResetAspect();
        }
    }
}
