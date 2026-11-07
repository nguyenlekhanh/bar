using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.TextCore.LowLevel;

namespace TikTokLiveGame
{
    /// <summary>
    /// Shared stream typography. Inter is bundled in Resources and converted to
    /// dynamic SDF atlases at runtime so glyphs stay smooth at 720p and 1080p.
    /// </summary>
    public static class OverlayTypography
    {
        private const int AtlasSize = 1024;
        private const int SamplingPointSize = 64;
        private const int AtlasPadding = 8;

        private static TMP_FontAsset body;
        private static TMP_FontAsset bold;
        private static TMP_FontAsset symbolFallback;
        private static Font guiBody;
        private static Font guiBold;

        public static TMP_FontAsset Body
        {
            get
            {
                if (body == null) body = CreateFontAsset("Fonts/Inter-SemiBold", "Inter SemiBold SDF");
                return body;
            }
        }

        public static TMP_FontAsset Bold
        {
            get
            {
                if (bold == null) bold = CreateFontAsset("Fonts/Inter-Bold", "Inter Bold SDF");
                return bold;
            }
        }

        public static Font GuiBody
        {
            get
            {
                if (guiBody == null) guiBody = Resources.Load<Font>("Fonts/Inter-SemiBold");
                return guiBody;
            }
        }

        public static Font GuiBold
        {
            get
            {
                if (guiBold == null) guiBold = Resources.Load<Font>("Fonts/Inter-Bold");
                return guiBold;
            }
        }

        public static TextMeshPro CreateWorldText(Transform parent, string name, int layer, bool useBold,
            float fontSize, Color color, TextAlignmentOptions alignment, int sortingOrder, bool outline = true)
        {
            GameObject textObject = new(name);
            textObject.layer = layer;
            textObject.transform.SetParent(parent, false);
            // Adding TMP to an active object invokes Awake before the font is
            // assigned and would fall back to the default TMP font.
            textObject.SetActive(false);

            TextMeshPro text = textObject.AddComponent<TextMeshPro>();
            text.font = useBold ? Bold : Body;
            text.fontSize = fontSize;
            text.color = color;
            text.alignment = alignment;
            text.textWrappingMode = TextWrappingModes.NoWrap;
            text.overflowMode = TextOverflowModes.Overflow;
            text.richText = false;
            text.fontStyle = FontStyles.Normal;
            text.lineSpacing = 0f;
            text.characterSpacing = 0f;
            text.enableAutoSizing = false;
            text.extraPadding = true;
            text.margin = Vector4.zero;
            text.rectTransform.pivot = new Vector2(0f, 0.5f);
            text.rectTransform.sizeDelta = new Vector2(100f, fontSize);
            textObject.GetComponent<MeshRenderer>().sortingOrder = sortingOrder;
            textObject.SetActive(true);
            if (outline)
            {
                // A narrow, 74% opaque edge keeps white glyphs readable over
                // the bright stage without the heavy halo of the old TextMesh.
                text.outlineWidth = 0.055f;
                text.outlineColor = new Color32(0, 0, 0, 190);
            }
            return text;
        }

        private static TMP_FontAsset CreateFontAsset(string resourcePath, string assetName)
        {
            Font source = Resources.Load<Font>(resourcePath);
            if (source == null)
            {
                Debug.LogWarning($"Typography font missing at Resources/{resourcePath}; using the TMP default.");
                return TMP_Settings.defaultFontAsset;
            }

            TMP_FontAsset asset = TMP_FontAsset.CreateFontAsset(
                source,
                SamplingPointSize,
                AtlasPadding,
                GlyphRenderMode.SDFAA,
                AtlasSize,
                AtlasSize,
                AtlasPopulationMode.Dynamic,
                true);
            if (asset == null)
            {
                Debug.LogWarning($"Could not create SDF font asset for {resourcePath}; using the TMP default.");
                return TMP_Settings.defaultFontAsset;
            }

            asset.name = assetName;
            // Dynamic atlases grow only for the characters actually used by the
            // stream, so Vietnamese names and rare symbols remain available.
            asset.TryAddCharacters("ăâđêôơưĂÂĐÊÔƠƯáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ");
            AddSymbolFallback(asset);
            return asset;
        }

        private static void AddSymbolFallback(TMP_FontAsset target)
        {
            if (target == null) return;
            if (symbolFallback == null) symbolFallback = CreateSymbolFallback();
            if (symbolFallback == null || symbolFallback == target) return;
            target.fallbackFontAssetTable ??= new List<TMP_FontAsset>();
            if (!target.fallbackFontAssetTable.Contains(symbolFallback))
                target.fallbackFontAssetTable.Add(symbolFallback);
        }

        private static TMP_FontAsset CreateSymbolFallback()
        {
            Font source = Font.CreateDynamicFontFromOSFont(new[] { "Segoe UI Symbol", "Arial Unicode MS" }, SamplingPointSize);
            if (source == null) return null;
            TMP_FontAsset asset = TMP_FontAsset.CreateFontAsset(
                source,
                SamplingPointSize,
                AtlasPadding,
                GlyphRenderMode.SDFAA,
                AtlasSize,
                AtlasSize,
                AtlasPopulationMode.Dynamic,
                true);
            if (asset != null)
            {
                asset.name = "Inter Symbol Fallback SDF";
                // Keep common stream decorations in the first dynamic atlas so
                // 3D labels and the overlay resolve them identically.
                asset.TryAddCharacters("★☆♥♡•→←↑↓✓✔✕✖");
            }
            return asset;
        }
    }
}
