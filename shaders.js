'use strict';

/**
 * ============================================================================
 *  AP3 · 光照与纹理场景 —— shaders.js（第一阶段交付）
 *  全部着色器源码：WebGL 2.0 / GLSL ES 3.00
 *  （课程平台要求：Angel & Shreiner《Interactive Computer Graphics》8th ed.）
 * ============================================================================
 *
 *  一、着色器程序清单
 *    · SHADOW_VS / SHADOW_FS —— 阴影贴图第一遍：深度精确编码写入 RGBA 颜色缓冲
 *    · PICK_VS / PICK_FS     —— 离屏颜色编码拾取（教材 3.9）
 *    · SKYBOX_VS / SKYBOX_FS —— 立方体环境贴图天空盒（教材 7.6）
 *    · MAIN_VS / MAIN_FS     —— 主光照 Pass：
 *        标准 Phong 三分量（教材 Ch6）+ 双光源（方向光产生阴影 / 点光源距离衰减）
 *        + 多纹理严格隔离（2D / Cubemap / ShadowMap / NormalMap 四个独立纹理单元）
 *        + 选做 E1 法线贴图、E2 透明度混合、E3 Blinn-Phong 与 Toon 卡通着色
 *        + 选中高亮（Rim Light 边缘发光）
 *
 *  二、阴影深度编码方案（确保 100% 兼容所有浏览器）
 *    WebGL2 也可用 DEPTH_COMPONENT24 深度纹理 + sampler2DShadow 自动比较，
 *    但本工程采用「深度打包进 RGBA 四通道颜色缓冲」的方案：
 *      packDepthToRGBA() 把 [0,1] 窗口深度拆为 4×8bit 共 32bit 精度写入
 *      RGBA/UNSIGNED_BYTE 纹理，不依赖深度纹理/浮点纹理，任何 WebGL2 浏览器
 *      行为完全一致；第二遍在 MAIN_FS 中 unpackRGBAToDepth() 解包后与当前
 *      片元深度比较 —— 即教材 Ch8.8 的「两遍渲染」阴影贴图原理。
 *    方向光采用正交投影 → 窗口深度与光源视深线性相关 → bias 调节稳定。
 *
 *  三、与 main.js 的接口契约（第二阶段 main.js 必须严格遵循）
 *    1) 顶点属性位置已用 layout(location=N) 在着色器内固定，无需 bindAttribLocation：
 *       MAIN                    : a_Position(0) a_Normal(1) a_UV(2) a_Tangent(3)
 *       SHADOW / PICK / SKYBOX  : a_Position(0)
 *    2) 纹理单元（main.js 负责 activeTexture / bindTexture / uniform1i）：
 *       u_Tex2D     -> TEXTURE0   普通 2D 位图纹理（教材 Ch7，texImage2D 上传）
 *       u_CubeMap   -> TEXTURE1   立方体环境贴图（教材 7.6，6 面依次上传）
 *       u_ShadowMap -> TEXTURE2   阴影深度贴图（教材 8.8，FBO 颜色附件）
 *       u_NormalMap -> TEXTURE3   法线贴图（选做 E1，与砖墙纹理同布局）
 *    3) 阴影贴图纹理参数（main.js 必须按此创建，否则深度解包失真）：
 *       内部格式 RGBA/UNSIGNED_BYTE；MIN/MAG 滤波 NEAREST（禁止线性滤波混合
 *       各通道字节）；WRAP_S/T = CLAMP_TO_EDGE；不生成 mipmap。
 *    4) MAIN 程序统一矩阵：u_ModelMatrix、u_ViewMatrix、u_ProjMatrix（透视）、
 *       u_NormalMatrix（mat3：模型矩阵上 3x3 的逆转置，法线变换）、
 *       u_ModelMat3（mat3：模型矩阵上 3x3，切线变换）、
 *       u_LightSpaceMatrix（光源 View * Ortho）。
 *    5) 主着色模型切换：u_ShadingMode = 0 Phong | 1 Blinn-Phong | 2 Toon（E3）；
 *       三分量开关：u_EnableAmbient / u_EnableDiffuse / u_EnableSpecular；
 *       材质参数：u_AmbientStrength / u_DiffuseColor / u_SpecularStrength /
 *                 u_Shininess（评分量规「光照正确性」的四个 uniform）；
 *       阴影：u_ReceiveShadow / u_ShadowPCF（3x3 软阴影开关）/ u_ShadowBias /
 *             u_ShadowMapSize；
 *       拾取高亮：u_IsSelected / u_SelectionColor；
 *       透明度：u_Alpha（E2，配合 main.js 的 gl.blendFunc 混合状态）。
 * ============================================================================
 */

(function (global) {

  /* ====================== 1. 阴影贴图 Pass（教材 8.8） ====================== */

  const SHADOW_VS = `#version 300 es
precision highp float;

// 阴影第一遍：把顶点变换到光源裁剪空间（方向光使用正交投影）
layout(location = 0) in vec3 a_Position;
uniform mat4 u_ModelMatrix;       // 模型矩阵（世界变换）
uniform mat4 u_LightSpaceMatrix;  // 光源空间 View * Proj

void main() {
  gl_Position = u_LightSpaceMatrix * u_ModelMatrix * vec4(a_Position, 1.0);
}
`;

  const SHADOW_FS = `#version 300 es
precision highp float;
layout(location = 0) out vec4 outColor;

// 把窗口深度 z∈[0,1] 打包为 RGBA 四通道（各 8bit，共 32bit 精度）。
// 不依赖 depth texture / 浮点纹理扩展 → 所有 WebGL2 浏览器行为一致。
vec4 packDepthToRGBA(float v) {
  const vec4 bitShift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
  const vec4 bitMask  = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
  vec4 res = fract(v * bitShift);
  res -= res.xxyz * bitMask;      // 消除低通道进位导致的误差
  return res;
}

void main() {
  // 方向光采用正交投影时，gl_FragCoord.z 与光源视深线性相关 → bias 调节稳定；
  // 上限钳制避免 z == 1.0 时打包回绕（实际场景深度远小于 1，钳制仅作保险）。
  outColor = packDepthToRGBA(min(gl_FragCoord.z, 0.99999));
}
`;

  /* ====================== 2. 离屏拾取 Pass（教材 3.9） ====================== */

  const PICK_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_Position;
uniform mat4 u_ModelMatrix;
uniform mat4 u_ViewProjMatrix;    // 与屏幕显示完全相同的相机 View * Proj

void main() {
  gl_Position = u_ViewProjMatrix * u_ModelMatrix * vec4(a_Position, 1.0);
}
`;

  const PICK_FS = `#version 300 es
precision highp float;
layout(location = 0) out vec4 outColor;

uniform vec4 u_PickColor;         // 每个物体的唯一 ID 颜色（如 (id/255, 0, 0, 1)）

void main() {
  outColor = u_PickColor;         // 颜色编码拾取（教材 3.9）：读回像素值即得物体 ID
}
`;

  /* ====================== 3. 天空盒 Pass（教材 7.6） ====================== */

  const SKYBOX_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_Position;  // 单位立方体顶点（±1），本地坐标即采样方向
uniform mat4 u_ViewProjMatrix;            // 去掉平移分量的 View*Proj：天空盒随相机移动

out vec3 v_TexCoord;

void main() {
  v_TexCoord = a_Position;
  vec4 pos = u_ViewProjMatrix * vec4(a_Position, 1.0);
  gl_Position = pos.xyww;   // 令 z=w → NDC 深度恒为 1（远平面），绝不遮挡场景物体
}
`;

  const SKYBOX_FS = `#version 300 es
precision highp float;
layout(location = 0) out vec4 outColor;

uniform samplerCube u_CubeMap;    // 与反射球共用同一 Cubemap（TEXTURE1）
in vec3 v_TexCoord;

void main() {
  outColor = texture(u_CubeMap, normalize(v_TexCoord));
}
`;

  /* ====================== 4. 主光照 Pass（教材 Ch6/Ch7 + E1/E2/E3） ====================== */

  const MAIN_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Normal;
layout(location = 2) in vec2 a_UV;
layout(location = 3) in vec3 a_Tangent;

uniform mat4 u_ModelMatrix;
uniform mat4 u_ViewMatrix;
uniform mat4 u_ProjMatrix;
uniform mat4 u_LightSpaceMatrix;   // 阴影采样用：光源 View * Ortho
uniform mat3 u_NormalMatrix;       // 法线：模型矩阵上 3x3 的逆转置
uniform mat3 u_ModelMat3;          // 切线：模型矩阵上 3x3（方向变换不平移）

// 注：GLSL ES 3.00 中 layout(location) 仅允许用于顶点输入与片元输出，
// 顶点输出/片元输入按名称匹配（MAIN_FS 中同名 in 声明一一对应）。
out vec3 v_WorldPos;
out vec3 v_Normal;
out vec2 v_UV;
out mat3 v_TBN;              // 切线空间 -> 世界空间
out vec4 v_LightSpacePos;

void main() {
  vec4 worldPos = u_ModelMatrix * vec4(a_Position, 1.0);
  v_WorldPos = worldPos.xyz;
  v_UV       = a_UV;

  vec3 N = normalize(u_NormalMatrix * a_Normal);
  v_Normal = N;

  // 构造 TBN 矩阵（选做 E1 法线贴图：把切线空间法线变换到世界空间）
  vec3 T = normalize(u_ModelMat3 * a_Tangent);
  T = normalize(T - dot(T, N) * N);       // Gram-Schmidt：强制 T ⊥ N
  vec3 B = cross(N, T);
  v_TBN = mat3(T, B, N);

  v_LightSpacePos = u_LightSpaceMatrix * worldPos;   // 用于阴影深度比较
  gl_Position = u_ProjMatrix * u_ViewMatrix * worldPos;
}
`;

  const MAIN_FS = `#version 300 es
precision highp float;      // 阴影深度解包需要 highp（24bit 有效精度）

in vec3 v_WorldPos;
in vec3 v_Normal;
in vec2 v_UV;
in mat3 v_TBN;
in vec4 v_LightSpacePos;

layout(location = 0) out vec4 outColor;

/* ---------------- 光照结构 ---------------- */
struct DirLight {
  vec3 direction;   // 光线传播方向（从光源指向场景，计算时取反得 L）
  vec3 color;
};
struct PointLight {
  vec3 position;
  vec3 color;
  float constant;   // 距离衰减：1 / (constant + linear*d + quadratic*d^2)
  float linear;
  float quadratic;
};

uniform DirLight   u_DirLight;
uniform PointLight u_PointLight;
uniform vec3 u_CameraPos;

/* ------- Phong 三分量独立开关与材质参数（评分量规「光照正确性」） ------- */
uniform bool  u_EnableAmbient;
uniform bool  u_EnableDiffuse;
uniform bool  u_EnableSpecular;
uniform float u_AmbientStrength;    // 环境光强度
uniform vec3  u_DiffuseColor;       // 材质漫反射基色（与纹理相乘）
uniform float u_SpecularStrength;   // 镜面强度
uniform float u_Shininess;          // 高光指数

/* ------- 着色模型：0=Phong  1=Blinn-Phong  2=Toon（选做 E3） ------- */
uniform int  u_ShadingMode;
uniform int  u_ToonLevels;          // Toon 漫反射阶梯数（2~6 可调）

/* ------- 多纹理：四个独立纹理单元严格隔离 ------- */
uniform sampler2D   u_Tex2D;        // TEXTURE0 普通 2D 位图纹理（教材 Ch7）
uniform samplerCube u_CubeMap;      // TEXTURE1 立方体环境贴图（教材 7.6）
uniform sampler2D   u_ShadowMap;    // TEXTURE2 阴影深度贴图（教材 8.8）
uniform sampler2D   u_NormalMap;    // TEXTURE3 法线贴图（选做 E1）
uniform bool  u_HasTex2D;           // 是否采样 2D 纹理
uniform bool  u_HasCubeMap;         // 是否采样环境反射
uniform bool  u_HasNormalMap;       // 是否采样法线贴图
uniform float u_ReflectionStrength; // 环境反射混合系数 0~1

/* ------- 阴影参数 ------- */
uniform bool  u_ReceiveShadow;      // 是否接收阴影（地面等开启）
uniform bool  u_ShadowPCF;          // PCF 3x3 软阴影开关（对比锯齿/漏光）
uniform float u_ShadowBias;         // 深度偏移：消除阴影 acne（自阴影/漏光）
uniform float u_ShadowMapSize;      // 阴影贴图边长（texel = 1/size）

/* ------- 拾取高亮与透明度 ------- */
uniform bool  u_IsSelected;         // 选中物体叠加边缘发光（Rim Light）
uniform vec3  u_SelectionColor;
uniform float u_Alpha;              // 选做 E2：透明度（配合 Alpha Blending）

/* ================= 深度解包（与 SHADOW_FS 的 packDepthToRGBA 配对） ================= */
float unpackRGBAToDepth(vec4 v) {
  const vec4 bitShift = vec4(1.0 / (256.0 * 256.0 * 256.0),
                             1.0 / (256.0 * 256.0),
                             1.0 / 256.0,
                             1.0);
  return dot(v, bitShift);
}

/* ================= 阴影可见度：深度比较 + 可选 PCF 3x3 ================= */
float shadowVisibility() {
  vec3 proj = v_LightSpacePos.xyz / v_LightSpacePos.w;
  vec2 uv   = proj.xy * 0.5 + 0.5;
  float currentDepth = proj.z * 0.5 + 0.5;

  // 光源视锥之外（无贴图覆盖）→ 视为被照亮
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || currentDepth > 1.0) {
    return 1.0;
  }

  float texel = 1.0 / u_ShadowMapSize;

  if (u_ShadowPCF) {
    // PCF 3x3：邻域 9 次采样平均 → 阴影边缘软化，消除阶梯锯齿
    float shadow = 0.0;
    for (int x = -1; x <= 1; ++x) {
      for (int y = -1; y <= 1; ++y) {
        vec2 off = vec2(float(x), float(y)) * texel;
        float stored = unpackRGBAToDepth(texture(u_ShadowMap, uv + off));
        shadow += ((currentDepth - u_ShadowBias) > stored) ? 1.0 : 0.0;
      }
    }
    return 1.0 - shadow / 9.0;
  } else {
    // 硬阴影：单点采样（可与 PCF 对比观察锯齿）
    float stored = unpackRGBAToDepth(texture(u_ShadowMap, uv));
    return ((currentDepth - u_ShadowBias) > stored) ? 0.0 : 1.0;
  }
}

/* ================= 漫反射项（Toon 模式下做阶梯量化） ================= */
float calcDiffuse(vec3 N, vec3 L) {
  float d = max(dot(N, L), 0.0);
  if (u_ShadingMode == 2) {
    float levels = float(u_ToonLevels);
    d = floor(d * levels + 0.5) / levels;   // 量化到 levels 个阶梯
    d = clamp(d, 0.0, 1.0);
  }
  return d;
}

/* ================= 高光项（三种着色模型对比，选做 E3） ================= */
float calcSpecular(vec3 N, vec3 V, vec3 L) {
  if (u_ShadingMode == 0) {
    // Phong：反射向量 R = reflect(-L, N) 与视线 V 的夹角（教材 Ch6）
    vec3 R = reflect(-L, N);
    return pow(max(dot(V, R), 0.0), u_Shininess);
  } else if (u_ShadingMode == 1) {
    // Blinn-Phong：半程向量 H = normalize(L + V)，计算 N·H（计算量更小）
    vec3 H = normalize(L + V);
    return pow(max(dot(N, H), 0.0), u_Shininess);
  } else {
    // Toon：阈值判定 → 硬边高光块
    vec3 H = normalize(L + V);
    return smoothstep(0.55, 0.75, max(dot(N, H), 0.0));
  }
}

void main() {
  vec3 N = normalize(v_Normal);
  vec3 V = normalize(u_CameraPos - v_WorldPos);

  /* ---- 选做 E1：法线贴图（切线空间 → 世界空间） ---- */
  if (u_HasNormalMap) {
    vec3 tn = texture(u_NormalMap, v_UV).rgb * 2.0 - 1.0;
    N = normalize(v_TBN * tn);
  }

  /* ---- 反照率 = 材质基色 × 2D 纹理 ---- */
  vec3 albedo = u_DiffuseColor;
  if (u_HasTex2D) {
    albedo *= texture(u_Tex2D, v_UV).rgb;
  }

  /* ---- 环境光分量（全局项） ---- */
  vec3 ambient = vec3(0.0);
  if (u_EnableAmbient) {
    ambient = u_AmbientStrength * u_DirLight.color * albedo;
  }

  /* ---- 方向光（主光源，产生阴影） ---- */
  vec3 Ld = normalize(-u_DirLight.direction);
  vec3 dirLight = vec3(0.0);
  if (u_EnableDiffuse) {
    dirLight += calcDiffuse(N, Ld) * u_DirLight.color * albedo;
  }
  if (u_EnableSpecular) {
    dirLight += calcSpecular(N, V, Ld) * u_DirLight.color * u_SpecularStrength;
  }
  if (u_ReceiveShadow) {
    dirLight *= shadowVisibility();     // 阴影只作用于方向光的漫反射+镜面
  }

  /* ---- 点光源（带距离衰减） ---- */
  vec3 Lp = u_PointLight.position - v_WorldPos;
  float dist = length(Lp);
  Lp /= max(dist, 1e-4);
  float attenuation = 1.0 / (u_PointLight.constant
                           + u_PointLight.linear * dist
                           + u_PointLight.quadratic * dist * dist);
  vec3 pointLight = vec3(0.0);
  if (u_EnableDiffuse) {
    pointLight += calcDiffuse(N, Lp) * u_PointLight.color * albedo;
  }
  if (u_EnableSpecular) {
    pointLight += calcSpecular(N, V, Lp) * u_PointLight.color * u_SpecularStrength;
  }
  pointLight *= attenuation;

  vec3 color = ambient + dirLight + pointLight;

  /* ---- 立方体环境反射（教材 7.6）：R = reflect(I, N) 采样 ---- */
  if (u_HasCubeMap) {
    vec3 I = normalize(v_WorldPos - u_CameraPos);   // 入射方向（片元→相机）
    vec3 R = reflect(I, N);                         // 反射向量
    vec3 env = texture(u_CubeMap, R).rgb;
    color = mix(color, env, u_ReflectionStrength);
  }

  /* ---- 选中高亮：边缘发光（Rim Light） ---- */
  if (u_IsSelected) {
    float fresnel = 1.0 - max(dot(N, V), 0.0);
    float rim = pow(fresnel, 3.0);
    color += u_SelectionColor * (0.12 + rim * 1.6);
  }

  /* ---- Toon 描边感：法线与视线趋于 90° 时压暗形成轮廓线 ---- */
  if (u_ShadingMode == 2) {
    float fresnel = 1.0 - max(dot(N, V), 0.0);
    float outline = smoothstep(0.68, 0.95, fresnel);
    color = mix(color, color * 0.35 + vec3(0.02, 0.03, 0.06), outline);
  }

  outColor = vec4(color, u_Alpha);   // u_Alpha：选做 E2 透明度
}
`;

  /* ====================== 导出 ====================== */
  const Shaders = {
    SHADOW_VS, SHADOW_FS,
    PICK_VS, PICK_FS,
    SKYBOX_VS, SKYBOX_FS,
    MAIN_VS, MAIN_FS,
  };

  global.Shaders = Shaders;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Shaders;   // 兼容 Node 环境做离线校验
  }
})(typeof window !== 'undefined' ? window : this);
