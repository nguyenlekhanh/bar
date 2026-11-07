Shader "TikTokLiveGame/ClubGlow"
{
    Properties
    {
        _Color ("Tint", Color) = (1,1,1,1)
        _Intensity ("Intensity", Range(0,4)) = 1
        _Falloff ("Falloff", Range(0.5,5)) = 2.2
    }

    SubShader
    {
        Tags
        {
            "Queue"="Transparent+30"
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
                float2 uv : TEXCOORD0;
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
            };

            fixed4 _Color;
            half _Intensity;
            half _Falloff;

            v2f vert (appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                float2 p = i.uv * 2.0 - 1.0;
                float radius = saturate(length(p));
                float falloff = pow(1.0 - radius, _Falloff);
                float alpha = falloff * _Color.a * _Intensity;
                return fixed4(_Color.rgb * alpha, alpha);
            }
            ENDCG
        }
    }

    FallBack Off
}
