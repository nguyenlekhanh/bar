Shader "TikTokLiveGame/ClubBeam"
{
    Properties
    {
        _Color ("Tint", Color) = (1,1,1,1)
        _Intensity ("Intensity", Range(0,4)) = 1
        _Softness ("Edge Softness", Range(0.5,6)) = 2.4
        _BandScale ("Band Scale", Float) = 11
        _BandSpeed ("Band Speed", Float) = 2.2
    }

    SubShader
    {
        Tags
        {
            "Queue"="Transparent+40"
            "RenderType"="Transparent"
            "IgnoreProjector"="True"
            "DisableBatching"="True"
        }

        Blend One One
        ZWrite Off
        Cull Off
        Lighting Off
        Fog { Mode Off }

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            struct appdata
            {
                float4 vertex : POSITION;
                float3 normal : NORMAL;
                float2 uv : TEXCOORD0;
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float3 worldPos : TEXCOORD1;
                float3 worldNormal : TEXCOORD2;
            };

            fixed4 _Color;
            half _Intensity;
            half _Softness;
            half _BandScale;
            half _BandSpeed;

            v2f vert (appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                o.worldPos = mul(unity_ObjectToWorld, v.vertex).xyz;
                o.worldNormal = UnityObjectToWorldNormal(v.normal);
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                float3 normal = normalize(i.worldNormal);
                float3 viewDir = normalize(_WorldSpaceCameraPos - i.worldPos);

                // Rim-weighted volume: the silhouette of the cone carries most of
                // the light, the centre stays translucent so dancers remain visible.
                float rim = pow(saturate(1.0 - abs(dot(normal, viewDir))), _Softness);

                float along = saturate(i.uv.y);
                float lengthFade = smoothstep(0.0, 0.09, along) * pow(1.0 - along, 1.45);
                float bands = 0.80 + 0.20 * sin(along * _BandScale - _Time.y * _BandSpeed + i.uv.x * 6.2831);

                float alpha = (0.45 + 0.55 * rim) * lengthFade * bands * _Color.a * _Intensity;
                return fixed4(_Color.rgb * alpha, alpha);
            }
            ENDCG
        }
    }

    FallBack Off
}
