using System;
using System.Collections;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using TMPro;
using UnityEngine;
using UnityEngine.Networking;

namespace TikTokLiveGame
{
    [Serializable]
    public sealed class InstructionConfigDto
    {
        public int version;
        public int revision;
        public string position;
        public int marginX;
        public int marginY;
        public int fontSize;
        public int iconSize;
        public int lineSpacing;
        public int panelWidth;
        public float opacity;
        public int maxVisibleLines;
        public bool scroll;
        public InstructionLineDto[] lines;
    }

    [Serializable]
    public sealed class InstructionLineDto
    {
        public string id;
        public string title;
        public string subtitle;
        public string icon;
        public string iconFile;
        public string textColor;
        public string iconColor;
        public bool enabled;
        public bool highlight;
    }

    [Serializable]
    internal sealed class InstructionEnvelope
    {
        public string type;
        public InstructionConfigDto config;
    }

    /// <summary>
    /// Screen-space instruction panel. It renders through its own orthographic
    /// camera on layer 31, which keeps it independent of the moving gameplay
    /// camera and lets the scene camera ignore it. Rows are pooled and only the
    /// text/geometry changes when the bridge sends a new configuration.
    /// </summary>
    public sealed class LiveInstructionOverlay : MonoBehaviour
    {
        private const int OverlayLayer = 31;
        private const int MaxRows = 20;
        private const float DesignHeight = 1920f;
        private const float PageSeconds = 5.5f;
        // Inter's TMP line box measures about 0.121 world units per font point in
        // world mode, and the panel's design line height is 1.18x the font size.
        private const float LineBoxPerPoint = 0.121f;
        private const float LineHeightScale = 1.18f;
        private static readonly Regex IconFilePattern = new(@"^[a-z0-9][a-z0-9_-]{0,63}\.png$", RegexOptions.Compiled);
        private static readonly HashSet<string> BuiltinIcons = new()
        {
            "zoom", "change", "walk", "ruler", "crown", "fire",
            "gift", "heart", "star", "music", "mic", "dice", "image"
        };

        private readonly List<InstructionLine> enabledLines = new();
        private readonly List<RowView> rows = new();
        private readonly Dictionary<string, Sprite> iconCache = new();
        private readonly HashSet<string> loadingIcons = new();
        private readonly HashSet<string> failedIcons = new();
        private readonly List<ChipLayout> chips = new();
        private readonly List<float> lineHeights = new();

        private TikTokWebSocketClient client;
        private Camera overlayCamera;
        private Camera lastMainCamera;
        private GameObject overlayRoot;
        private GameObject panelObject;
        private SpriteRenderer panelBackground;
        private SpriteRenderer panelBorder;
        private Sprite whiteSprite;
        private static Material overlayMaterial;
        private InstructionConfigDto config;
        private bool initialized;
        private int layoutWidth;
        private int layoutHeight;
        private bool forcedScreenSize;
        private int pageStart;
        private float pageTimer;
        private float panelAlpha;
        private float panelTarget;
        private float rowReveal;
        private float currentPanelX;
        private float currentPanelY;
        private float currentPanelWidth;
        private float currentPanelHeight;
        private float currentScale = 1f;
        private int currentRevision = -1;

        public Camera OverlayCamera => overlayCamera;
        public bool IsInitialized => initialized;

        private sealed class InstructionLine
        {
            public string id;
            public string title;
            public string subtitle;
            public string icon;
            public string iconFile;
            public Color textColor;
            public Color iconColor;
            public bool enabled;
            public bool highlight;
        }

        private sealed class RowView
        {
            public GameObject root;
            public SpriteRenderer highlight;
            public SpriteRenderer accent;
            public SpriteRenderer icon;
            public TextMeshPro title;
        }

        private sealed class ChipLayout
        {
            public RowView row;
            public InstructionLine line;
            public float x;
            public float y;
            public float width;
            public float height;
            public int lineIndex;
        }

        private sealed class FlowResult
        {
            public float width;
            public float height;
            public float padding;
            public float iconSize;
            public float iconGap;
        }

        private void Awake() => EnsureCreated();

        private void OnDestroy()
        {
            if (client != null) client.InstructionConfigReceived -= HandleInstructionJson;
            if (overlayRoot != null) Destroy(overlayRoot);
        }

        public void Initialize(TikTokWebSocketClient socketClient)
        {
            EnsureCreated();
            if (client == socketClient) return;
            if (client != null) client.InstructionConfigReceived -= HandleInstructionJson;
            client = socketClient;
            if (client != null)
            {
                client.InstructionConfigReceived += HandleInstructionJson;
                if (!string.IsNullOrEmpty(client.LastInstructionConfigJson))
                    HandleInstructionJson(client.LastInstructionConfigJson);
            }
        }

        private void EnsureCreated()
        {
            if (initialized) return;
            initialized = true;
            if (Screen.width > 0 && Screen.height > 0)
            {
                Vector2Int content = StreamViewport.ContentSize;
                layoutWidth = content.x;
                layoutHeight = content.y;
            }
            else
            {
                layoutWidth = 720;
                layoutHeight = 1280;
            }

            overlayRoot = new GameObject("Live Instruction Overlay");
            overlayRoot.transform.SetParent(transform, false);
            whiteSprite = Sprite.Create(Texture2D.whiteTexture, new Rect(0f, 0f, 1f, 1f), new Vector2(0.5f, 0.5f), 1f);

            GameObject cameraObject = new("Instruction Overlay Camera");
            cameraObject.transform.SetParent(overlayRoot.transform, false);
            cameraObject.transform.position = new Vector3(0f, 0f, -10f);
            overlayCamera = cameraObject.AddComponent<Camera>();
            overlayCamera.orthographic = true;
            overlayCamera.orthographicSize = layoutHeight * 0.5f;
            overlayCamera.aspect = layoutWidth / (float)Mathf.Max(1, layoutHeight);
            overlayCamera.clearFlags = CameraClearFlags.Depth;
            overlayCamera.cullingMask = 1 << OverlayLayer;
            overlayCamera.depth = 100f;
            overlayCamera.nearClipPlane = 0.1f;
            overlayCamera.farClipPlane = 50f;
            overlayCamera.allowHDR = false;
            overlayCamera.allowMSAA = false;
            overlayCamera.useOcclusionCulling = false;
            overlayCamera.enabled = true;
            ApplyOverlayViewport();

            panelObject = CreateSprite("Instruction Panel", overlayRoot.transform, Vector3.zero, new Color(0.015f, 0.02f, 0.05f, 0.58f));
            panelBackground = panelObject.GetComponent<SpriteRenderer>();
            panelBackground.sortingOrder = 0;
            GameObject border = CreateSprite("Instruction Panel Border", overlayRoot.transform, Vector3.zero, new Color(0.35f, 0.95f, 1f, 0.55f));
            panelBorder = border.GetComponent<SpriteRenderer>();
            panelBorder.sortingOrder = 1;

            for (int index = 0; index < MaxRows; index++) rows.Add(CreateRow(index));
            RefreshMainCameraMask();
            ApplyVisuals();
        }

        private RowView CreateRow(int index)
        {
            RowView view = new();
            view.root = new GameObject($"Instruction Row {index + 1}");
            view.root.transform.SetParent(overlayRoot.transform, false);
            view.root.layer = OverlayLayer;

            GameObject highlightObject = CreateSprite("Highlight", view.root.transform, new Vector3(0f, 0f, -0.04f), Color.clear);
            view.highlight = highlightObject.GetComponent<SpriteRenderer>();
            view.highlight.sortingOrder = 1;

            GameObject accentObject = CreateSprite("Accent", view.root.transform, new Vector3(0f, 0f, -0.08f), Color.clear);
            view.accent = accentObject.GetComponent<SpriteRenderer>();
            view.accent.sortingOrder = 2;

            GameObject iconObject = CreateSprite("Icon", view.root.transform, new Vector3(0f, 0f, -0.1f), Color.white);
            view.icon = iconObject.GetComponent<SpriteRenderer>();
            view.icon.sortingOrder = 3;

            view.title = OverlayTypography.CreateWorldText(
                view.root.transform, "Title", OverlayLayer, true, 64f, Color.white,
                TextAlignmentOptions.MidlineLeft, 4);
            view.title.richText = true;
            view.title.textWrappingMode = TextWrappingModes.NoWrap;
            view.title.transform.localPosition = new Vector3(0f, 0f, -0.2f);
            view.root.SetActive(false);
            return view;
        }

        private GameObject CreateSprite(string name, Transform parent, Vector3 position, Color color)
        {
            GameObject spriteObject = new(name);
            spriteObject.layer = OverlayLayer;
            spriteObject.transform.SetParent(parent, false);
            spriteObject.transform.localPosition = position;
            SpriteRenderer renderer = spriteObject.AddComponent<SpriteRenderer>();
            renderer.sprite = whiteSprite;
            renderer.sharedMaterial = OverlayMaterial();
            renderer.color = color;
            return spriteObject;
        }

        private static Material OverlayMaterial()
        {
            if (overlayMaterial != null) return overlayMaterial;
            Shader shader = Shader.Find("Sprites/Default");
            if (shader == null) shader = Shader.Find("Unlit/Transparent");
            overlayMaterial = shader != null ? new Material(shader) : null;
            return overlayMaterial;
        }

        private void HandleInstructionJson(string json)
        {
            if (string.IsNullOrEmpty(json) || json.IndexOf("instruction_config", StringComparison.Ordinal) < 0) return;
            try
            {
                InstructionEnvelope envelope = JsonUtility.FromJson<InstructionEnvelope>(json);
                if (envelope?.config != null) ApplyConfig(envelope.config);
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"Instruction overlay ignored malformed config: {exception.Message}");
            }
        }

        public void ApplyConfig(InstructionConfigDto next)
        {
            EnsureCreated();
            if (next == null) return;
            config = Sanitize(next);
            currentRevision = config.revision;
            enabledLines.Clear();
            foreach (InstructionLine line in BuildLines(config))
                if (line.enabled) enabledLines.Add(line);

            pageStart = 0;
            pageTimer = 0f;
            rowReveal = 0f;
            panelAlpha = 0f;
            panelTarget = enabledLines.Count > 0 ? 1f : 0f;
            currentScale = Mathf.Max(0.35f, layoutHeight / DesignHeight);
            Relayout();
            RequestCustomIcons();
            ApplyVisuals();
        }

        private static InstructionConfigDto Sanitize(InstructionConfigDto input)
        {
            InstructionConfigDto value = new()
            {
                version = 1,
                revision = Mathf.Clamp(input.revision, 0, 1000000),
                position = string.IsNullOrWhiteSpace(input.position) ? "top-right" : input.position.Trim(),
                marginX = Mathf.Clamp(input.marginX, 0, 200),
                marginY = Mathf.Clamp(input.marginY, 0, 240),
                fontSize = Mathf.Clamp(input.fontSize, 20, 60),
                iconSize = Mathf.Clamp(input.iconSize, 24, 80),
                lineSpacing = Mathf.Clamp(input.lineSpacing, 0, 30),
                panelWidth = Mathf.Clamp(input.panelWidth <= 0 ? 500 : input.panelWidth, 200, 720),
                opacity = Mathf.Clamp(input.opacity, 0f, 0.9f),
                maxVisibleLines = Mathf.Clamp(input.maxVisibleLines <= 0 ? 6 : input.maxVisibleLines, 1, 20),
                scroll = input.scroll,
                lines = input.lines ?? Array.Empty<InstructionLineDto>()
            };
            if (!IsKnownPosition(value.position)) value.position = "top-right";
            return value;
        }

        private static bool IsKnownPosition(string value) =>
            value is "top-left" or "top-right" or "bottom-left" or "bottom-right" or "top-center" or "bottom-center";

        private static IEnumerable<InstructionLine> BuildLines(InstructionConfigDto source)
        {
            foreach (InstructionLineDto raw in source.lines ?? Array.Empty<InstructionLineDto>())
            {
                if (raw == null) continue;
                string title = CleanText(raw.title, 160);
                string subtitle = CleanText(raw.subtitle, 240);
                if (string.IsNullOrEmpty(title) && string.IsNullOrEmpty(subtitle)) continue;
                string icon = string.IsNullOrWhiteSpace(raw.icon) ? "image" : raw.icon.Trim().ToLowerInvariant();
                if (!BuiltinIcons.Contains(icon)) icon = "image";
                string iconFile = icon == "image" ? CleanIconFile(raw.iconFile) : string.Empty;
                yield return new InstructionLine
                {
                    id = string.IsNullOrWhiteSpace(raw.id) ? Guid.NewGuid().ToString("N") : raw.id,
                    title = title,
                    subtitle = subtitle,
                    icon = icon,
                    iconFile = iconFile,
                    textColor = ParseColor(raw.textColor, Color.white),
                    iconColor = ParseColor(raw.iconColor, new Color(1f, 0.84f, 0.3f)),
                    highlight = raw.highlight,
                    enabled = raw.enabled
                };
            }
        }

        private static string CleanText(string value, int maxLength)
        {
            if (string.IsNullOrWhiteSpace(value)) return string.Empty;
            string cleaned = Regex.Replace(value, @"[\u0000-\u001f\u007f]", " ");
            cleaned = Regex.Replace(cleaned, @"\s+", " ").Trim();
            return cleaned.Length <= maxLength ? cleaned : cleaned.Substring(0, maxLength - 1) + "…";
        }

        private static string CleanIconFile(string value)
        {
            string file = (value ?? string.Empty).Trim().ToLowerInvariant();
            return IconFilePattern.IsMatch(file) ? file : string.Empty;
        }

        private static Color ParseColor(string value, Color fallback) =>
            !string.IsNullOrWhiteSpace(value) && ColorUtility.TryParseHtmlString(value, out Color color) ? color : fallback;

        private float UiScale => currentScale;

        private void Relayout()
        {
            if (config == null || enabledLines.Count == 0)
            {
                panelTarget = 0f;
                if (panelObject != null) panelObject.SetActive(false);
                if (panelBorder != null) panelBorder.gameObject.SetActive(false);
                foreach (RowView row in rows) row.root.SetActive(false);
                return;
            }

            float scale = UiScale;
            float marginX = config.marginX * scale;
            float marginY = config.marginY * scale;
            float availableWidth = Mathf.Max(160f, layoutWidth - marginX * 2f);
            float availableHeight = Mathf.Max(160f, layoutHeight - marginY * 2f);

            int maxVisible = Mathf.Clamp(config.maxVisibleLines, 1, MaxRows);
            int pageCount = Mathf.Max(1, Mathf.CeilToInt(enabledLines.Count / (float)maxVisible));
            if (config.scroll && pageStart >= enabledLines.Count) pageStart = 0;
            if (!config.scroll) pageStart = 0;
            int from = config.scroll ? Mathf.Clamp(pageStart, 0, enabledLines.Count - 1) : 0;
            int visibleCount = Mathf.Min(maxVisible, enabledLines.Count - from);

            FlowResult flow = null;
            float fit = 1f;
            for (int attempt = 0; attempt < 6; attempt++)
            {
                flow = LayoutFlow(from, visibleCount, availableWidth, scale, fit);
                if (flow.height <= availableHeight + 0.5f) break;
                float next = Mathf.Clamp(fit * Mathf.Sqrt(availableHeight / flow.height) * 0.98f, 0.4f, fit - 0.02f);
                if (next <= 0.4001f) break;
                fit = next;
            }

            float panelWidth = flow.width;
            float panelHeight = Mathf.Min(flow.height, availableHeight);
            float panelX = config.position.Contains("left")
                ? -layoutWidth * 0.5f + marginX + panelWidth * 0.5f
                : config.position.Contains("right")
                    ? layoutWidth * 0.5f - marginX - panelWidth * 0.5f
                    : 0f;
            float panelY = config.position.Contains("bottom")
                ? -layoutHeight * 0.5f + marginY + panelHeight * 0.5f
                : layoutHeight * 0.5f - marginY - panelHeight * 0.5f;
            panelX = Mathf.Clamp(panelX, -layoutWidth * 0.5f + panelWidth * 0.5f, layoutWidth * 0.5f - panelWidth * 0.5f);
            panelY = Mathf.Clamp(panelY, -layoutHeight * 0.5f + panelHeight * 0.5f, layoutHeight * 0.5f - panelHeight * 0.5f);

            currentPanelX = panelX;
            currentPanelY = panelY;
            currentPanelWidth = panelWidth;
            currentPanelHeight = panelHeight;
            panelObject.SetActive(true);
            panelBorder.gameObject.SetActive(true);
            panelObject.transform.localPosition = new Vector3(panelX, panelY, 0f);
            panelObject.transform.localScale = new Vector3(panelWidth, panelHeight, 1f);
            panelBorder.transform.localPosition = new Vector3(panelX, panelY + panelHeight * 0.5f - 2f * scale, -0.03f);
            panelBorder.transform.localScale = new Vector3(panelWidth, Mathf.Max(1f, 2f * scale), 1f);

            float iconSize = flow.iconSize;
            float iconGap = flow.iconGap;
            for (int index = 0; index < rows.Count; index++)
            {
                RowView row = rows[index];
                if (index >= chips.Count)
                {
                    row.root.SetActive(false);
                    continue;
                }

                ChipLayout chip = chips[index];
                float chipLeft = -panelWidth * 0.5f + flow.padding + chip.x;
                row.root.SetActive(true);
                row.root.transform.localPosition = new Vector3(panelX, panelY + chip.y, 0f);
                row.highlight.transform.localPosition = new Vector3(chipLeft + chip.width * 0.5f, 0f, -0.04f);
                row.highlight.transform.localScale = new Vector3(chip.width, chip.height, 1f);
                row.accent.transform.localPosition = new Vector3(chipLeft - 3f * scale, 0f, -0.08f);
                row.accent.transform.localScale = new Vector3(Mathf.Max(2f, 3f * scale), chip.height * 0.86f, 1f);
                row.icon.transform.localPosition = new Vector3(chipLeft + iconSize * 0.5f, 0f, -0.1f);
                row.icon.transform.localScale = Vector3.one * iconSize;
                row.icon.sprite = SpriteFor(chip.line);
                row.title.transform.localPosition = new Vector3(chipLeft + iconSize + iconGap, 0f, -0.2f);
                row.title.gameObject.SetActive(true);
            }

            pageTimer = Mathf.Clamp(pageTimer, 0f, PageSeconds);
        }

        /// <summary>
        /// Flows every visible instruction into one continuous run of text,
        /// starting a new line only when the next chip would pass the usable
        /// width. A chip wider than the panel wraps internally, so instruction
        /// text is never clipped, truncated or pushed off screen.
        /// </summary>
        private FlowResult LayoutFlow(int from, int visibleCount, float availableWidth, float scale, float fit)
        {
            float padding = 13f * scale * fit;
            float iconSize = Mathf.Max(8f, config.iconSize * scale * fit);
            float iconGap = Mathf.Max(2f, 10f * scale * fit);
            float chipGap = Mathf.Max(6f, 18f * scale * fit);
            float lineGap = Mathf.Max(0f, config.lineSpacing * scale * fit);
            float fontSize = Mathf.Max(6f, config.fontSize * scale * fit);
            float lineBox = fontSize * LineHeightScale;
            float points = lineBox / LineBoxPerPoint;

            chips.Clear();
            float totalWidth = 0f;
            for (int index = 0; index < visibleCount; index++)
            {
                ChipLayout chip = new() { row = rows[index], line = enabledLines[from + index] };
                chip.row.root.SetActive(true);
                chip.row.title.gameObject.SetActive(true);
                chip.row.title.richText = true;
                chip.row.title.fontSize = points;
                chip.row.title.textWrappingMode = TextWrappingModes.NoWrap;
                chip.row.title.text = BuildChipText(chip.line, points);
                chip.row.title.ForceMeshUpdate(true, true);
                float textWidth = Mathf.Max(fontSize, chip.row.title.textBounds.size.x);
                chip.width = iconSize + iconGap + textWidth;
                chip.height = Mathf.Max(iconSize, chip.row.title.textBounds.size.y, lineBox);
                chips.Add(chip);
                totalWidth += chip.width + (index > 0 ? chipGap : 0f);
            }

            bool singleLine = totalWidth + padding * 2f <= availableWidth + 0.5f;
            float width = Mathf.Min(singleLine ? totalWidth + padding * 2f : availableWidth, availableWidth);
            // panelWidth is a minimum: a short run hugs its text, a long run uses
            // the full width the screen allows before it is allowed to wrap.
            float minWidth = Mathf.Min(Mathf.Max(120f, config.panelWidth * scale * fit), availableWidth);
            width = Mathf.Max(width, minWidth);
            float contentWidth = Mathf.Max(40f, width - padding * 2f);

            foreach (ChipLayout chip in chips)
            {
                if (chip.width <= contentWidth + 0.5f) continue;
                float textWidth = Mathf.Max(fontSize, contentWidth - iconSize - iconGap);
                chip.row.title.textWrappingMode = TextWrappingModes.Normal;
                chip.row.title.rectTransform.sizeDelta = new Vector2(textWidth, lineBox);
                chip.row.title.ForceMeshUpdate(true, true);
                chip.width = contentWidth;
                chip.height = Mathf.Max(iconSize, chip.row.title.textBounds.size.y, lineBox);
            }

            lineHeights.Clear();
            float cursor = 0f;
            float lineHeight = 0f;
            foreach (ChipLayout chip in chips)
            {
                if (cursor > 0f && cursor + chip.width > contentWidth + 0.5f)
                {
                    lineHeights.Add(lineHeight);
                    cursor = 0f;
                    lineHeight = 0f;
                }
                chip.x = cursor;
                chip.lineIndex = lineHeights.Count;
                cursor += chip.width + chipGap;
                lineHeight = Mathf.Max(lineHeight, chip.height);
            }
            lineHeights.Add(Mathf.Max(lineHeight, lineBox));

            float height = padding * 2f;
            for (int index = 0; index < lineHeights.Count; index++)
                height += lineHeights[index] + (index > 0 ? lineGap : 0f);

            float lineCenter = height * 0.5f - padding;
            for (int index = 0; index < lineHeights.Count; index++)
            {
                lineCenter -= lineHeights[index] * 0.5f;
                foreach (ChipLayout chip in chips)
                    if (chip.lineIndex == index) chip.y = lineCenter;
                lineCenter -= lineHeights[index] * 0.5f + lineGap;
            }

            return new FlowResult
            {
                width = width,
                height = height,
                padding = padding,
                iconSize = iconSize,
                iconGap = iconGap
            };
        }

        private static string BuildChipText(InstructionLine line, float titlePoints)
        {
            string title = EscapeRichText(line.title);
            if (string.IsNullOrEmpty(line.subtitle)) return title;
            int subtitlePoints = Mathf.Max(1, Mathf.RoundToInt(titlePoints * 0.62f));
            return $"{title} <size={subtitlePoints}>{EscapeRichText(line.subtitle)}</size>";
        }

        private static string EscapeRichText(string value) =>
            string.IsNullOrEmpty(value)
                ? string.Empty
                : value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

        private Sprite SpriteFor(InstructionLine line)
        {
            if (!string.IsNullOrEmpty(line.iconFile) && iconCache.TryGetValue(line.iconFile, out Sprite custom))
                return custom;
            return InstructionIconLibrary.Get(line.icon);
        }

        private void RequestCustomIcons()
        {
            foreach (InstructionLine line in enabledLines)
            {
                if (string.IsNullOrEmpty(line.iconFile)) continue;
                if (iconCache.ContainsKey(line.iconFile) || loadingIcons.Contains(line.iconFile) || failedIcons.Contains(line.iconFile)) continue;
                string url = BuildIconUrl(line.iconFile);
                if (url == null) { failedIcons.Add(line.iconFile); continue; }
                loadingIcons.Add(line.iconFile);
                StartCoroutine(LoadIcon(line.iconFile, url));
            }
        }

        private string BuildIconUrl(string file)
        {
            if (string.IsNullOrEmpty(file) || !IconFilePattern.IsMatch(file)) return null;
            string server = client != null && !string.IsNullOrWhiteSpace(client.ServerUrl)
                ? client.ServerUrl
                : "ws://127.0.0.1:3000";
            if (!Uri.TryCreate(server, UriKind.Absolute, out Uri baseUri)) return null;
            string scheme = baseUri.Scheme == "wss" ? "https" : "http";
            if (!Uri.TryCreate($"{scheme}://{baseUri.Host}:{baseUri.Port}/assets/instruction-icons/{file}", UriKind.Absolute, out Uri uri)) return null;
            bool loopback = uri.Host == "127.0.0.1" || uri.Host == "localhost" || uri.Host == "::1";
            if (!loopback || uri.Port != baseUri.Port) return null;
            if (!uri.AbsolutePath.StartsWith("/assets/instruction-icons/", StringComparison.Ordinal)) return null;
            return uri.AbsoluteUri;
        }

        private IEnumerator LoadIcon(string file, string url)
        {
            using UnityWebRequest request = UnityWebRequest.Get(url);
            request.timeout = 5;
            yield return request.SendWebRequest();
            loadingIcons.Remove(file);
            if (request.result != UnityWebRequest.Result.Success)
            {
                failedIcons.Add(file);
                yield break;
            }

            byte[] bytes = request.downloadHandler?.data;
            if (bytes == null || bytes.Length == 0 || bytes.Length > 256 * 1024 ||
                bytes.Length < 24 || bytes[0] != 0x89 || bytes[1] != 0x50 || bytes[2] != 0x4e || bytes[3] != 0x47)
            {
                failedIcons.Add(file);
                yield break;
            }
            int width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
            int height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
            if (width < 1 || height < 1 || width > 512 || height > 512)
            {
                failedIcons.Add(file);
                yield break;
            }

            Texture2D texture = new(2, 2, TextureFormat.RGBA32, false);
            if (!texture.LoadImage(bytes))
            {
                Destroy(texture);
                failedIcons.Add(file);
                yield break;
            }
            texture.wrapMode = TextureWrapMode.Clamp;
            texture.filterMode = FilterMode.Bilinear;
            // Built-in glyphs are 64x64 at 64 PPU, so one unit equals iconSize.
            // Imported PNGs can be any square size (the rose is 195x195); use
            // their largest dimension as PPU so iconSize remains the on-screen
            // size instead of scaling by texture.width / 64.
            float pixelsPerUnit = Mathf.Max(1f, Mathf.Max(texture.width, texture.height));
            Sprite sprite = Sprite.Create(texture, new Rect(0f, 0f, texture.width, texture.height), new Vector2(0.5f, 0.5f), pixelsPerUnit);
            iconCache[file] = sprite;
            Relayout();
            ApplyVisuals();
        }

        private void Update() => Step(Time.unscaledDeltaTime);

        private void ApplyOverlayViewport()
        {
            if (overlayCamera == null) return;
            if (forcedScreenSize)
                overlayCamera.rect = new Rect(0f, 0f, 1f, 1f);
            else
                overlayCamera.rect = StreamViewport.NormalizedRect;
            overlayCamera.orthographicSize = layoutHeight * 0.5f;
            overlayCamera.aspect = forcedScreenSize
                ? layoutWidth / (float)Mathf.Max(1, layoutHeight)
                : StreamViewport.TargetAspect;
        }

        /// <summary>Exposed so the headless render test can advance the animation.</summary>
        public void Step(float deltaTime)
        {
            if (!initialized) return;
            if (!forcedScreenSize)
            {
                Vector2Int content = StreamViewport.ContentSize;
                if (content.x != layoutWidth || content.y != layoutHeight)
                {
                    layoutWidth = content.x;
                    layoutHeight = content.y;
                    currentScale = Mathf.Max(0.35f, layoutHeight / DesignHeight);
                    Relayout();
                }
                ApplyOverlayViewport();
            }

            RefreshMainCameraMask();
            if (enabledLines.Count > 0 && config != null && config.scroll && enabledLines.Count > config.maxVisibleLines)
            {
                pageTimer += Mathf.Max(0f, deltaTime);
                if (pageTimer >= PageSeconds)
                {
                    pageTimer = 0f;
                    pageStart += config.maxVisibleLines;
                    if (pageStart >= enabledLines.Count) pageStart = 0;
                    rowReveal = 0f;
                    Relayout();
                }
            }

            float target = panelTarget;
            panelAlpha = Mathf.MoveTowards(panelAlpha, target, Mathf.Max(0.01f, deltaTime / 0.35f));
            rowReveal = Mathf.MoveTowards(rowReveal, target > 0f ? 1f : 0f, Mathf.Max(0.01f, deltaTime / 0.32f));
            ApplyVisuals();
        }

        /// <summary>Completes the fade for a still-frame preview.</summary>
        public void CompleteAnimations()
        {
            panelAlpha = panelTarget;
            rowReveal = panelTarget > 0f ? 1f : 0f;
            ApplyVisuals();
        }

        public void SetScreenSize(int width, int height)
        {
            EnsureCreated();
            forcedScreenSize = true;
            layoutWidth = Mathf.Max(1, width);
            layoutHeight = Mathf.Max(1, height);
            currentScale = Mathf.Max(0.35f, layoutHeight / DesignHeight);
            ApplyOverlayViewport();
            Relayout();
            ApplyVisuals();
        }

        private void RefreshMainCameraMask()
        {
            Camera main = Camera.main;
            if (main == lastMainCamera) return;
            lastMainCamera = main;
            if (main != null) main.cullingMask &= ~(1 << OverlayLayer);
        }

        private void ApplyVisuals()
        {
            if (!initialized || config == null) return;
            bool visible = panelAlpha > 0.001f;
            panelObject.SetActive(visible);
            panelBorder.gameObject.SetActive(visible);
            if (!visible)
            {
                foreach (RowView row in rows) row.root.SetActive(false);
                return;
            }

            float opacity = config.opacity * panelAlpha;
            panelBackground.color = new Color(0.015f, 0.02f, 0.05f, opacity);
            panelBorder.color = new Color(0.35f, 0.95f, 1f, 0.55f * panelAlpha);
            float pulse = 0.5f + 0.5f * Mathf.Sin(Time.unscaledTime * 2.1f);
            int maxVisible = Mathf.Clamp(config.maxVisibleLines, 1, MaxRows);
            int from = config.scroll ? pageStart : 0;
            int visibleCount = Mathf.Min(maxVisible, enabledLines.Count - from);
            for (int index = 0; index < rows.Count; index++)
            {
                RowView row = rows[index];
                if (index >= visibleCount)
                {
                    row.root.SetActive(false);
                    continue;
                }
                InstructionLine line = enabledLines[from + index];
                row.root.SetActive(true);
                float alpha = panelAlpha * rowReveal;
                Color text = line.textColor;
                text.a = alpha;
                row.title.color = text;
                Color iconColor = line.iconColor;
                iconColor.a = alpha;
                row.icon.color = iconColor;
                row.highlight.color = new Color(line.iconColor.r, line.iconColor.g, line.iconColor.b,
                    line.highlight ? (0.08f + 0.05f * pulse) * alpha : 0f);
                row.accent.color = new Color(line.iconColor.r, line.iconColor.g, line.iconColor.b,
                    (line.highlight ? 0.65f + 0.3f * pulse : 0.22f) * alpha);
            }
        }
    }

    /// <summary>Procedural 64px built-in glyphs: no external art or remote URLs.</summary>
    internal static class InstructionIconLibrary
    {
        private static readonly Dictionary<string, Sprite> cache = new();

        public static Sprite Get(string id)
        {
            string key = string.IsNullOrEmpty(id) ? "image" : id;
            if (cache.TryGetValue(key, out Sprite sprite)) return sprite;
            Texture2D texture = Build(key);
            sprite = Sprite.Create(texture, new Rect(0f, 0f, 64f, 64f), new Vector2(0.5f, 0.5f), 64f);
            cache[key] = sprite;
            return sprite;
        }

        private static Texture2D Build(string id)
        {
            Func<float, float, bool> shape = id switch
            {
                "zoom" => Zoom,
                "change" => Change,
                "walk" => Walk,
                "ruler" => Ruler,
                "crown" => Crown,
                "fire" => Fire,
                "gift" => Gift,
                "heart" => Heart,
                "star" => Star,
                "music" => Music,
                "mic" => Mic,
                "dice" => Dice,
                _ => Image
            };
            Texture2D texture = new(64, 64, TextureFormat.RGBA32, false)
            {
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
                name = $"Instruction Icon {id}"
            };
            Color32[] pixels = new Color32[64 * 64];
            for (int y = 0; y < 64; y++)
            {
                for (int x = 0; x < 64; x++)
                {
                    int hits = 0;
                    for (int sy = 0; sy < 3; sy++)
                        for (int sx = 0; sx < 3; sx++)
                        {
                            float fx = (x + (sx + 0.5f) / 3f) / 64f;
                            float fy = (y + (sy + 0.5f) / 3f) / 64f;
                            if (shape(fx, fy)) hits++;
                        }
                    byte a = (byte)(hits * 255 / 9);
                    pixels[y * 64 + x] = new Color32(255, 255, 255, a);
                }
            }
            texture.SetPixels32(pixels);
            texture.Apply(false, true);
            return texture;
        }

        private static bool Zoom(float x, float y) =>
            Ring(x, y, 0.45f, 0.53f, 0.23f, 0.055f) ||
            DistanceToSegment(x, y, 0.6f, 0.4f, 0.82f, 0.18f) < 0.06f;

        private static bool Change(float x, float y)
        {
            bool top = Ring(x, y, 0.5f, 0.5f, 0.24f, 0.055f) && y > 0.53f;
            bool bottom = Ring(x, y, 0.5f, 0.5f, 0.24f, 0.055f) && y < 0.47f;
            return top || bottom ||
                (y > 0.5f && x < 0.3f && x > 0.2f) ||
                (y < 0.5f && x > 0.7f && x < 0.8f);
        }

        private static bool Walk(float x, float y) =>
            Circle(x, y, 0.43f, 0.79f, 0.095f) ||
            DistanceToSegment(x, y, 0.43f, 0.68f, 0.52f, 0.46f) < 0.045f ||
            DistanceToSegment(x, y, 0.52f, 0.46f, 0.34f, 0.16f) < 0.05f ||
            DistanceToSegment(x, y, 0.52f, 0.46f, 0.7f, 0.15f) < 0.05f ||
            DistanceToSegment(x, y, 0.44f, 0.62f, 0.29f, 0.48f) < 0.04f ||
            DistanceToSegment(x, y, 0.46f, 0.62f, 0.65f, 0.53f) < 0.04f;

        private static bool Ruler(float x, float y)
        {
            bool body = InRect(x, y, 0.1f, 0.36f, 0.9f, 0.64f) &&
                !InRect(x, y, 0.15f, 0.41f, 0.85f, 0.59f);
            bool ticks = InRect(x, y, 0.23f, 0.36f, 0.27f, 0.47f) ||
                InRect(x, y, 0.36f, 0.36f, 0.4f, 0.5f) ||
                InRect(x, y, 0.49f, 0.36f, 0.53f, 0.47f) ||
                InRect(x, y, 0.62f, 0.36f, 0.66f, 0.5f) ||
                InRect(x, y, 0.75f, 0.36f, 0.79f, 0.47f);
            return body || ticks;
        }

        private static bool Crown(float x, float y) =>
            Polygon(x, y, new[] {
                new Vector2(0.1f, 0.28f), new Vector2(0.1f, 0.62f), new Vector2(0.3f, 0.45f),
                new Vector2(0.5f, 0.76f), new Vector2(0.7f, 0.45f), new Vector2(0.9f, 0.62f),
                new Vector2(0.9f, 0.28f)
            }) || InRect(x, y, 0.1f, 0.19f, 0.9f, 0.29f);

        private static bool Fire(float x, float y) =>
            Polygon(x, y, new[] {
                new Vector2(0.5f, 0.9f), new Vector2(0.66f, 0.64f), new Vector2(0.58f, 0.58f),
                new Vector2(0.74f, 0.4f), new Vector2(0.63f, 0.2f), new Vector2(0.36f, 0.2f),
                new Vector2(0.26f, 0.38f), new Vector2(0.35f, 0.56f), new Vector2(0.29f, 0.62f)
            });

        private static bool Gift(float x, float y) =>
            InRect(x, y, 0.18f, 0.16f, 0.82f, 0.56f) ||
            InRect(x, y, 0.12f, 0.56f, 0.88f, 0.7f) ||
            InRect(x, y, 0.46f, 0.16f, 0.54f, 0.7f) ||
            Circle(x, y, 0.41f, 0.75f, 0.085f) || Circle(x, y, 0.59f, 0.75f, 0.085f);

        private static bool Heart(float x, float y)
        {
            float hx = (x - 0.5f) / 0.34f;
            float hy = (y - 0.48f) / 0.34f;
            float value = hx * hx + hy * hy - 1f;
            return value * value * value - hx * hx * hy * hy * hy <= 0f;
        }

        private static bool Star(float x, float y)
        {
            Vector2[] points = new Vector2[10];
            for (int index = 0; index < 10; index++)
            {
                float angle = Mathf.PI * 0.5f + index * Mathf.PI / 5f;
                float radius = index % 2 == 0 ? 0.36f : 0.16f;
                points[index] = new Vector2(0.5f + Mathf.Cos(angle) * radius, 0.5f + Mathf.Sin(angle) * radius);
            }
            return Polygon(x, y, points);
        }

        private static bool Music(float x, float y) =>
            Circle(x, y, 0.32f, 0.22f, 0.1f) || Circle(x, y, 0.7f, 0.32f, 0.1f) ||
            DistanceToSegment(x, y, 0.4f, 0.27f, 0.4f, 0.82f) < 0.04f ||
            DistanceToSegment(x, y, 0.78f, 0.37f, 0.78f, 0.9f) < 0.04f ||
            DistanceToSegment(x, y, 0.4f, 0.8f, 0.78f, 0.88f) < 0.045f;

        private static bool Mic(float x, float y) =>
            (Circle(x, y, 0.5f, 0.68f, 0.14f) && InRect(x, y, 0.36f, 0.56f, 0.64f, 0.7f)) ||
            DistanceToSegment(x, y, 0.5f, 0.47f, 0.5f, 0.22f) < 0.035f ||
            DistanceToSegment(x, y, 0.33f, 0.18f, 0.67f, 0.18f) < 0.035f;

        private static bool Dice(float x, float y)
        {
            if (!InRoundRect(x, y, 0.16f, 0.16f, 0.84f, 0.84f, 0.12f)) return false;
            return !(Circle(x, y, 0.33f, 0.33f, 0.055f) || Circle(x, y, 0.5f, 0.5f, 0.055f) ||
                Circle(x, y, 0.67f, 0.67f, 0.055f) || Circle(x, y, 0.67f, 0.33f, 0.055f) ||
                Circle(x, y, 0.33f, 0.67f, 0.055f));
        }

        private static bool Image(float x, float y)
        {
            bool frame = InRoundRect(x, y, 0.12f, 0.18f, 0.88f, 0.82f, 0.08f) &&
                !InRoundRect(x, y, 0.18f, 0.24f, 0.82f, 0.76f, 0.04f);
            bool sun = Circle(x, y, 0.3f, 0.64f, 0.06f);
            bool mountain = Polygon(x, y, new[] {
                new Vector2(0.2f, 0.28f), new Vector2(0.42f, 0.55f), new Vector2(0.56f, 0.4f),
                new Vector2(0.68f, 0.55f), new Vector2(0.8f, 0.28f)
            });
            return frame || sun || mountain;
        }

        private static bool Ring(float x, float y, float cx, float cy, float radius, float thickness)
        {
            float distance = Mathf.Sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
            return Mathf.Abs(distance - radius) <= thickness * 0.5f;
        }

        private static bool Circle(float x, float y, float cx, float cy, float radius) =>
            (x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius;

        private static bool InRect(float x, float y, float left, float bottom, float right, float top) =>
            x >= left && x <= right && y >= bottom && y <= top;

        private static float DistanceToSegment(float px, float py, float ax, float ay, float bx, float by)
        {
            float dx = bx - ax;
            float dy = by - ay;
            float lengthSquared = dx * dx + dy * dy;
            float t = lengthSquared <= 0.00001f ? 0f : Mathf.Clamp01(((px - ax) * dx + (py - ay) * dy) / lengthSquared);
            float x = ax + dx * t;
            float y = ay + dy * t;
            return Mathf.Sqrt((px - x) * (px - x) + (py - y) * (py - y));
        }

        private static bool Polygon(float x, float y, Vector2[] points)
        {
            bool inside = false;
            for (int i = 0, j = points.Length - 1; i < points.Length; j = i++)
            {
                if ((points[i].y > y) != (points[j].y > y) &&
                    x < (points[j].x - points[i].x) * (y - points[i].y) / (points[j].y - points[i].y) + points[i].x)
                    inside = !inside;
            }
            return inside;
        }

        private static bool InRoundRect(float x, float y, float left, float bottom, float right, float top, float radius)
        {
            if (x < left || x > right || y < bottom || y > top) return false;
            float cx = Mathf.Clamp(x, left + radius, right - radius);
            float cy = Mathf.Clamp(y, bottom + radius, top - radius);
            return Circle(x, y, cx, cy, radius);
        }
    }
}
