using UnityEngine;
using UnityEngine.Rendering;

namespace TikTokLiveGame
{
    /// <summary>
    /// Additive, shader-driven nightclub lighting. Everything here is a self-lit
    /// mesh (no UnityEngine.Light components): sweeping volumetric-style cones,
    /// floor glow pools, beat-synced strobes and a pooled gift spotlight.
    ///
    /// The rig is built once in Awake. At runtime only transforms, material
    /// property blocks and enabled flags change, so a 400-viewer room pays no
    /// per-frame allocation cost for the lighting.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class BarLightController : MonoBehaviour
    {
        public static BarLightController Instance { get; private set; }

        [Header("Master")]
        [Tooltip("Turns every bar-light effect off without touching gameplay.")]
        public bool lightingEnabled = true;
        [Range(0f, 3f)] public float masterIntensity = 1f;

        [Header("Brightness")]
        [Tooltip("Global multiplier applied by ClubBeam to every beam.")]
        [Range(0.5f, 4f)] public float beamBrightness = 1.6f;
        [Range(0.5f, 4f)] public float floorGlowBrightness = 1.7f;
        [Range(0.5f, 4f)] public float strobeBrightness = 1.5f;
        [Range(0.5f, 4f)] public float giftSpotlightBrightness = 1.8f;

        [Header("Beams")]
        public bool enableBeams = true;
        [Range(1, 24)] public int beamCount = 12;
        [Range(0.1f, 3f)] public float beamSpeed = 0.55f;
        [Range(0.4f, 3f)] public float beamWidth = 1f;
        [Range(6f, 30f)] public float beamLength = 20f;
        [Range(0.02f, 0.8f)] public float beamAlpha = 0.38f;
        [Range(0f, 1f)] public float stageSweep = 0.55f;
        [Tooltip("Local Z where beams start sweeping (stage side).")]
        public float sweepBackZ = -9f;
        [Tooltip("Local Z where beams end sweeping (crowd side, toward the camera).")]
        public float sweepFrontZ = 16f;

        [Header("Floor glow")]
        public bool enableFloorGlow = true;
        [Range(0f, 1f)] public float floorGlowAlpha = 0.40f;
        [Range(0.5f, 4f)] public float floorGlowScale = 2.0f;

        [Header("Beat / strobe")]
        public bool enableStrobe = true;
        [Range(1, 16)] public int strobeEveryBeats = 4;
        [Range(0f, 0.6f)] public float strobeIntensity = 0.24f;
        [Range(0f, 3f)] public float beatSensitivity = 1f;
        [Range(0f, 2f)] public float pulseAmount = 0.35f;

        [Header("Gift spotlight")]
        public bool enableGiftSpotlight = true;
        public Color giftColor = new Color(0.2f, 0.9f, 1f, 1f);
        public Color giftColorVip = new Color(1f, 0.22f, 0.68f, 1f);
        [Range(4f, 24f)] public float giftSpotlightRange = 13f;
        [Range(0.02f, 0.6f)] public float giftSpotlightAlpha = 0.5f;

        [Header("Gift colour sweep")]
        [Range(0f, 8f)] public float giftSweepSeconds = 2.5f;

        [Header("Palette")]
        public Color[] palette =
        {
            new Color(1f, 0.045f, 0.10f),
            new Color(0.045f, 0.28f, 1f),
            new Color(0.55f, 0.045f, 1f),
            new Color(0.00f, 0.98f, 1f),
            new Color(1f, 0.045f, 0.52f),
            new Color(1f, 0.50f, 0.03f),
            new Color(0.04f, 1f, 0.32f),
        };

        private const int RingFixtureCount = 12;
        private const float RingRadius = 3.52f;
        private static readonly Vector3 RingCenter = new Vector3(0f, 6.35f, -2.25f);
        private static readonly Quaternion RingTilt = Quaternion.Euler(10f, 0f, 0f);
        private static readonly int ColorId = Shader.PropertyToID("_Color");
        private static readonly int IntensityId = Shader.PropertyToID("_Intensity");

        private static Mesh coneMesh;
        private static Mesh planeMesh;

        private Material beamMaterial;
        private Material glowMaterial;
        private Material strobeMaterial;
        private Material giftMaterial;
        private Transform rigRoot;
        private BeamRig[] beams;
        private Transform overlay;
        private MeshRenderer overlayRenderer;
        private MaterialPropertyBlock overlayBlock;

        private BeamRig giftBeam;
        private Transform giftTarget;
        private bool giftVip;
        private float giftUntil;
        private bool giftActive;
        private float sweepUntil;
        private bool built;

        public int BeamCount => beams != null ? beams.Length : 0;
        public bool IsReady => built && beamMaterial != null && glowMaterial != null;

        private sealed class BeamRig
        {
            public Transform Root;
            public Vector3 Origin;
            public float Phase;
            public int ColorIndex;
            public float HalfAngle;
            public MeshRenderer Renderer;
            public MaterialPropertyBlock Block;
            public Transform Pool;
            public MeshRenderer PoolRenderer;
            public MaterialPropertyBlock PoolBlock;
            public Transform Fixture;
        }

        private void Awake()
        {
            Instance = this;
            EnsureInitialized();
        }

        private void OnDestroy()
        {
            if (Instance == this) Instance = null;
        }

        /// <summary>Builds the rig on demand; also used by the batch-mode smoke test.</summary>
        public void EnsureInitialized()
        {
            if (!built) BuildRig();
            ApplyEnabledState();
        }

        /// <summary>Lets the chroma-key mode hide the lighting without touching gameplay.</summary>
        public void SetLightingEnabled(bool enabled)
        {
            lightingEnabled = enabled;
            ApplyEnabledState();
        }

        private void ApplyEnabledState()
        {
            bool on = lightingEnabled;
            if (rigRoot != null) rigRoot.gameObject.SetActive(on);
            if (overlay != null) overlay.gameObject.SetActive(on);
            if (!on && giftBeam != null)
            {
                giftActive = false;
                giftTarget = null;
                if (giftBeam.Root != null) giftBeam.Root.gameObject.SetActive(false);
                if (giftBeam.Pool != null) giftBeam.Pool.gameObject.SetActive(false);
            }
        }

        private void BuildRig()
        {
            if (built) return;

            Shader beamShader = Resources.Load<Shader>("Shaders/ClubBeam");
            if (beamShader == null) beamShader = Shader.Find("TikTokLiveGame/ClubBeam");
            Shader glowShader = Resources.Load<Shader>("Shaders/ClubGlow");
            if (glowShader == null) glowShader = Shader.Find("TikTokLiveGame/ClubGlow");
            if (beamShader == null || glowShader == null)
            {
                Debug.LogError("BarLightController: ClubBeam/ClubGlow shader not found; bar lighting stays disabled.");
                lightingEnabled = false;
                built = true;
                return;
            }

            beamMaterial = new Material(beamShader) { name = "Club Beam (Runtime)" };
            glowMaterial = new Material(glowShader) { name = "Club Glow (Runtime)" };
            strobeMaterial = new Material(glowShader) { name = "Club Strobe (Runtime)" };
            strobeMaterial.renderQueue = 4000; // flash over sprites, never behind them
            giftMaterial = new Material(beamShader) { name = "Club Gift Beam (Runtime)" };

            if (coneMesh == null) coneMesh = BuildConeMesh(28);
            if (planeMesh == null) planeMesh = BuildPlaneMesh();

            rigRoot = new GameObject("Bar Light Rig").transform;
            rigRoot.SetParent(transform, false);

            int count = Mathf.Clamp(beamCount, 1, 24);
            beams = new BeamRig[count];
            int paletteLength = palette != null ? palette.Length : 0;

            for (int index = 0; index < count; index++)
            {
                float angle = index * Mathf.PI * 2f / count;
                Vector3 origin = RingCenter + RingTilt * new Vector3(
                    Mathf.Sin(angle) * RingRadius,
                    -0.34f,
                    Mathf.Cos(angle) * RingRadius);

                GameObject beamObject = CreateRenderable($"Beam {index}", coneMesh, beamMaterial, rigRoot);
                GameObject poolObject = CreateRenderable($"Beam Pool {index}", planeMesh, glowMaterial, rigRoot);

                BeamRig rig = new BeamRig
                {
                    Root = beamObject.transform,
                    Renderer = beamObject.GetComponent<MeshRenderer>(),
                    Block = new MaterialPropertyBlock(),
                    Pool = poolObject.transform,
                    PoolRenderer = poolObject.GetComponent<MeshRenderer>(),
                    PoolBlock = new MaterialPropertyBlock(),
                    Origin = origin,
                    Phase = index * 0.83f + (index % 3) * 0.37f,
                    ColorIndex = paletteLength > 0 ? index % paletteLength : 0,
                    HalfAngle = Mathf.Deg2Rad * Mathf.Lerp(9f, 16f, (index % 4) / 3f),
                };

                if (index < RingFixtureCount)
                {
                    GameObject fixture = GameObject.Find($"Moving Head Ring {index}");
                    if (fixture != null) rig.Fixture = fixture.transform;
                }

                beams[index] = rig;
            }

            GameObject giftObject = CreateRenderable("Gift Spotlight Beam", coneMesh, giftMaterial, rigRoot);
            GameObject giftPoolObject = CreateRenderable("Gift Spotlight Pool", planeMesh, glowMaterial, rigRoot);
            giftBeam = new BeamRig
            {
                Root = giftObject.transform,
                Renderer = giftObject.GetComponent<MeshRenderer>(),
                Block = new MaterialPropertyBlock(),
                Pool = giftPoolObject.transform,
                PoolRenderer = giftPoolObject.GetComponent<MeshRenderer>(),
                PoolBlock = new MaterialPropertyBlock(),
                HalfAngle = Mathf.Deg2Rad * 10f,
            };
            giftObject.SetActive(false);
            giftPoolObject.SetActive(false);

            Camera camera = Camera.main;
            if (camera != null)
            {
                GameObject overlayObject = CreateRenderable("Beat Strobe Overlay", planeMesh, strobeMaterial, camera.transform);
                overlayObject.transform.localPosition = new Vector3(0f, 0f, 1.25f);
                overlayObject.transform.localRotation = Quaternion.Euler(90f, 0f, 0f);
                overlay = overlayObject.transform;
                overlayRenderer = overlayObject.GetComponent<MeshRenderer>();
                overlayBlock = new MaterialPropertyBlock();
                overlayRenderer.enabled = false;
                FitOverlay(camera);
            }

            built = true;
        }

        private static GameObject CreateRenderable(string name, Mesh mesh, Material material, Transform parent)
        {
            GameObject go = new GameObject(name);
            go.transform.SetParent(parent, false);

            MeshFilter filter = go.AddComponent<MeshFilter>();
            filter.sharedMesh = mesh;

            MeshRenderer renderer = go.AddComponent<MeshRenderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = ShadowCastingMode.Off;
            renderer.receiveShadows = false;
            renderer.lightProbeUsage = LightProbeUsage.Off;
            renderer.reflectionProbeUsage = ReflectionProbeUsage.Off;
            renderer.motionVectorGenerationMode = MotionVectorGenerationMode.ForceNoMotion;
            return go;
        }

        private void Update()
        {
            if (!lightingEnabled || beams == null) return;

            beamMaterial.SetFloat(IntensityId, beamBrightness);
            glowMaterial.SetFloat(IntensityId, floorGlowBrightness);
            if (strobeMaterial != null) strobeMaterial.SetFloat(IntensityId, strobeBrightness);
            if (giftMaterial != null) giftMaterial.SetFloat(IntensityId, giftSpotlightBrightness);

            float beat = ClubBeatClock.Beat;
            float fraction = beat - Mathf.Floor(beat);
            int beatIndex = Mathf.FloorToInt(beat);
            bool drop = beatIndex % 32 >= 28;
            float beatPulse = Mathf.Exp(-fraction * 5.2f) * Mathf.Max(0f, beatSensitivity);
            float intensity = masterIntensity * (drop ? 1.2f : 1f);

            if (enableBeams || enableFloorGlow)
                UpdateBeams(beatPulse, intensity, drop, SweepOffset());
            if (giftActive)
                UpdateGiftSpotlight(beatPulse);
            UpdateStrobe(fraction, beatIndex, drop);
        }

        private void UpdateBeams(float beatPulse, float intensity, bool drop, int sweepOffset)
        {
            float time = Time.time;
            int paletteLength = palette != null ? palette.Length : 0;
            float pulse = 1f + beatPulse * pulseAmount;

            for (int index = 0; index < beams.Length; index++)
            {
                BeamRig rig = beams[index];
                if (rig == null || rig.Root == null) continue;

                if (rig.Root.gameObject.activeSelf != enableBeams) rig.Root.gameObject.SetActive(enableBeams);
                if (rig.Pool.gameObject.activeSelf != enableFloorGlow) rig.Pool.gameObject.SetActive(enableFloorGlow);
                if (!enableBeams && !enableFloorGlow) continue;

                float phase = rig.Phase;
                float sweep = time * beamSpeed * 0.7f + phase;
                float x = Mathf.Sin(sweep) * 6.4f;
                float depth = 0.5f + 0.5f * Mathf.Sin(time * beamSpeed * 0.43f + phase * 1.7f);
                float z = Mathf.Lerp(sweepBackZ, sweepFrontZ, Mathf.Lerp(depth, 0.5f, 1f - stageSweep));

                Vector3 targetLocal = new Vector3(x, 0.06f, z);
                Vector3 originWorld = rigRoot.TransformPoint(rig.Origin);
                Vector3 targetWorld = rigRoot.TransformPoint(targetLocal);
                Vector3 delta = targetWorld - originWorld;
                float distance = delta.magnitude;
                if (distance < 0.05f) continue;

                Vector3 direction = delta / distance;
                float length = Mathf.Min(distance, beamLength);

                if (enableBeams)
                {
                    rig.Root.position = originWorld;
                    rig.Root.rotation = Quaternion.LookRotation(direction, Vector3.up);
                    float width = Mathf.Tan(rig.HalfAngle) * length * beamWidth;
                    rig.Root.localScale = new Vector3(width, width, length);
                }

                if (rig.Fixture != null)
                {
                    Vector3 fixtureTarget = targetWorld + Vector3.up * 0.4f;
                    rig.Fixture.rotation = Quaternion.LookRotation(fixtureTarget - rig.Fixture.position, Vector3.up);
                }

                int colorIndex = paletteLength > 0 ? (rig.ColorIndex + sweepOffset) % paletteLength : 0;
                Color baseColor = paletteLength > 0 ? palette[colorIndex] : Color.white;

                if (enableBeams)
                {
                    float alpha = Mathf.Clamp01(beamAlpha * intensity * pulse * (drop ? 1.15f : 1f));
                    rig.Block.SetColor(ColorId, new Color(baseColor.r, baseColor.g, baseColor.b, alpha));
                    rig.Renderer.SetPropertyBlock(rig.Block);
                }

                if (enableFloorGlow)
                {
                    rig.Pool.position = targetWorld + Vector3.up * 0.05f;
                    float size = Mathf.Lerp(2.2f, 6.2f, Mathf.Clamp01(length / 18f)) * floorGlowScale;
                    rig.Pool.localScale = new Vector3(size, 1f, size);
                    float alpha = Mathf.Clamp01(floorGlowAlpha * intensity * pulse);
                    rig.PoolBlock.SetColor(ColorId, new Color(baseColor.r, baseColor.g, baseColor.b, alpha));
                    rig.PoolRenderer.SetPropertyBlock(rig.PoolBlock);
                }
            }
        }

        private void UpdateStrobe(float fraction, int beatIndex, bool drop)
        {
            if (overlayRenderer == null) return;

            float flash = 0f;
            if (enableStrobe)
            {
                int every = Mathf.Max(1, strobeEveryBeats);
                float window = drop ? 0.10f : 0.16f;
                if (beatIndex % every == 0 && fraction < window)
                    flash = 1f - fraction / window;
                if (drop && beatIndex % 32 >= 30 && fraction < 0.08f)
                    flash = Mathf.Max(flash, 1.4f);
            }

            overlayRenderer.enabled = flash > 0.001f;
            if (!overlayRenderer.enabled) return;

            Color tint = drop ? new Color(0.85f, 0.92f, 1f, 1f) : Color.white;
            float alpha = Mathf.Clamp01(flash * strobeIntensity * strobeBrightness * masterIntensity);
            overlayBlock.SetColor(ColorId, new Color(tint.r, tint.g, tint.b, alpha));
            overlayRenderer.SetPropertyBlock(overlayBlock);

            Camera camera = Camera.main;
            if (camera != null) FitOverlay(camera);
        }

        private void FitOverlay(Camera camera)
        {
            if (overlay == null || camera == null) return;
            const float distance = 1.25f;
            float height = 2f * Mathf.Tan(camera.fieldOfView * 0.5f * Mathf.Deg2Rad) * distance * 1.2f;
            float width = height * camera.aspect * 1.2f;
            overlay.localScale = new Vector3(width, 1f, height);
        }

        private int SweepOffset()
        {
            if (palette == null || palette.Length == 0 || Time.time >= sweepUntil) return 0;
            return Mathf.FloorToInt((sweepUntil - Time.time) * 6f);
        }

        /// <summary>Follows a gifting viewer with a soft, pooled spotlight cone.</summary>
        public void PlayGiftSpotlight(Transform target, bool vip, float seconds)
        {
            if (giftBeam == null || target == null) return;
            giftTarget = target;
            giftVip = vip;
            giftUntil = Time.time + Mathf.Clamp(seconds, 1f, 20f);
            giftActive = true;
            giftBeam.Root.gameObject.SetActive(enableGiftSpotlight && lightingEnabled);
            giftBeam.Pool.gameObject.SetActive(enableGiftSpotlight && lightingEnabled);
        }

        /// <summary>Briefly rotates the beam palette, used by VIP gifts.</summary>
        public void TriggerColorSweep()
        {
            sweepUntil = Time.time + Mathf.Max(0.1f, giftSweepSeconds);
        }

        private void UpdateGiftSpotlight(float beatPulse)
        {
            if (giftBeam == null) return;

            if (!enableGiftSpotlight || giftTarget == null || Time.time >= giftUntil)
            {
                giftActive = false;
                giftTarget = null;
                giftBeam.Root.gameObject.SetActive(false);
                giftBeam.Pool.gameObject.SetActive(false);
                return;
            }

            Vector3 target = giftTarget.position + Vector3.up * 0.9f;
            Vector3 origin = giftTarget.position + new Vector3(0f, 6.4f, 1.6f);
            Vector3 delta = target - origin;
            float distance = delta.magnitude;
            if (distance < 0.1f) return;

            Vector3 direction = delta / distance;
            float length = Mathf.Min(distance, giftSpotlightRange);

            giftBeam.Root.position = origin;
            giftBeam.Root.rotation = Quaternion.LookRotation(direction, Vector3.up);
            float width = Mathf.Tan(giftBeam.HalfAngle) * length;
            giftBeam.Root.localScale = new Vector3(width, width, length);

            Color color = giftVip ? giftColorVip : giftColor;
            float alpha = Mathf.Clamp01(giftSpotlightAlpha * (1f + beatPulse * 0.5f) * masterIntensity);
            giftBeam.Block.SetColor(ColorId, new Color(color.r, color.g, color.b, alpha));
            giftBeam.Renderer.SetPropertyBlock(giftBeam.Block);

            giftBeam.Pool.position = giftTarget.position + Vector3.up * 0.05f;
            float size = 4.4f * floorGlowScale;
            giftBeam.Pool.localScale = new Vector3(size, 1f, size);
            giftBeam.PoolBlock.SetColor(ColorId, new Color(color.r, color.g, color.b, Mathf.Clamp01(floorGlowAlpha * 1.1f)));
            giftBeam.PoolRenderer.SetPropertyBlock(giftBeam.PoolBlock);
        }

        private static Mesh BuildConeMesh(int segments)
        {
            int sides = Mathf.Max(8, segments);
            Vector3[] vertices = new Vector3[sides + 2];
            Vector3[] normals = new Vector3[sides + 2];
            Vector2[] uvs = new Vector2[sides + 2];
            int[] triangles = new int[sides * 3];

            vertices[0] = Vector3.zero;
            normals[0] = Vector3.forward;
            uvs[0] = new Vector2(0.5f, 0f);

            for (int index = 0; index <= sides; index++)
            {
                float angle = index * Mathf.PI * 2f / sides;
                float cos = Mathf.Cos(angle);
                float sin = Mathf.Sin(angle);
                vertices[index + 1] = new Vector3(cos, sin, 1f);
                normals[index + 1] = new Vector3(cos, sin, 0.45f).normalized;
                uvs[index + 1] = new Vector2(index / (float)sides, 1f);
            }

            for (int index = 0; index < sides; index++)
            {
                triangles[index * 3] = 0;
                triangles[index * 3 + 1] = index + 1;
                triangles[index * 3 + 2] = index + 2;
            }

            Mesh mesh = new Mesh { name = "Club Beam Cone" };
            mesh.vertices = vertices;
            mesh.normals = normals;
            mesh.uv = uvs;
            mesh.triangles = triangles;
            mesh.RecalculateBounds();
            return mesh;
        }

        private static Mesh BuildPlaneMesh()
        {
            Mesh mesh = new Mesh { name = "Club Glow Plane" };
            mesh.vertices = new[]
            {
                new Vector3(-0.5f, 0f, -0.5f),
                new Vector3(0.5f, 0f, -0.5f),
                new Vector3(0.5f, 0f, 0.5f),
                new Vector3(-0.5f, 0f, 0.5f),
            };
            mesh.uv = new[]
            {
                new Vector2(0f, 0f),
                new Vector2(1f, 0f),
                new Vector2(1f, 1f),
                new Vector2(0f, 1f),
            };
            mesh.normals = new[] { Vector3.up, Vector3.up, Vector3.up, Vector3.up };
            mesh.triangles = new[] { 0, 2, 1, 0, 3, 2 };
            mesh.RecalculateBounds();
            return mesh;
        }
    }
}
