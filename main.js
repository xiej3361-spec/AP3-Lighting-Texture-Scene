'use strict';

/**
 * ============================================================================
 *  AP3 · 光照与纹理场景 —— main.js（第二阶段交付）
 *  WebGL2 核心渲染管线：Shadow FBO 两遍阴影 → 天空盒 → 主光照 → 拾取调参
 * ============================================================================
 *  脚本加载顺序：shaders.js（global.Shaders）→ scene.js（global.Scene）→ main.js
 *
 *  管线总览（与 shaders.js 头部接口契约严格一致）：
 *    Pass 1 阴影遍：绑定 shadowFBO（1024×1024，RGBA 颜色附件 = 阴影贴图 +
 *                   DEPTH_COMPONENT24 深度 Renderbuffer），viewport 切到
 *                   1024×1024，用 SHADOW 程序把投射阴影的物体渲染到光源
 *                   裁剪空间，SHADOW_FS 将深度打包进 RGBA（教材 8.8 第一遍）；
 *    Pass 2 主光照遍：切回默认帧缓冲，恢复画布视口，先 SKYBOX 程序画天空盒
 *                   （深度恒为远平面、不写深度），再 MAIN 程序按"不透明在前、
 *                   透明在后"顺序渲染：不透明关 BLEND、开深度写入；透明
 *                   （玻璃方尖碑，E2）开 BLEND（SRC_ALPHA, ONE_MINUS_SRC_ALPHA）、
 *                   关深度写入 —— MAIN_FS 内解包阴影贴图深度并做比较/PCF。
 *    拾取：点击画布时用 PICK 程序把每个物体渲染为唯一 ID 颜色到 pickFBO
 *           （与画布同尺寸），gl.readPixels 读回点击像素 → 选中高亮 + 面板同步。
 *
 *  纹理单元固定分配（避免任何绑定串扰）：
 *    TEXTURE0 ← u_Tex2D     2D 位图纹理（未用时绑 1×1 白纹理兜底）
 *    TEXTURE1 ← u_CubeMap   立方体环境贴图（天空盒与反射球共用）
 *    TEXTURE2 ← u_ShadowMap shadowFBO 颜色纹理（NEAREST/CLAMP，禁 mipmap）
 *    TEXTURE3 ← u_NormalMap 程序化法线贴图（E1；未用时绑白纹理兜底）
 * ============================================================================
 */

(function (global) {

  const { Vec3, Mat4, SceneGeometry, ProceduralTextures, helpers } = global.Scene;
  const { clamp } = helpers;

  /* ============================ DOM 与上下文 ============================ */

  const canvas = document.getElementById('glCanvas');
  const overlay = document.getElementById('overlay');

  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.textContent = msg;
    }
    console.error(msg);
  }

  if (!canvas) { showError('找不到画布元素 #glCanvas'); return; }

  const gl = canvas.getContext('webgl2', { antialias: true, depth: true });
  if (!gl) {
    showError('当前浏览器不支持 WebGL 2.0，请使用最新版 Chrome / Edge / Firefox。');
    return;
  }

  /* ============================ 着色器编译 ============================ */

  function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('着色器编译失败：' + log + '\n\n---- 着色器源码 ----\n' + src);
    }
    return sh;
  }

  function createProgram(vsSrc, fsSrc) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('着色器程序链接失败：' + log);
    }
    return prog;
  }

  /** 收集程序内全部 active uniform 的 location（含 u_DirLight.direction 结构体成员） */
  function collectUniforms(prog) {
    const u = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i);
      u[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return u;
  }

  let shadowProg, shadowU, pickProg, pickU, skyboxProg, skyboxU, mainProg, mainU;
  try {
    shadowProg = createProgram(global.Shaders.SHADOW_VS, global.Shaders.SHADOW_FS);
    shadowU = collectUniforms(shadowProg);

    pickProg = createProgram(global.Shaders.PICK_VS, global.Shaders.PICK_FS);
    pickU = collectUniforms(pickProg);

    skyboxProg = createProgram(global.Shaders.SKYBOX_VS, global.Shaders.SKYBOX_FS);
    skyboxU = collectUniforms(skyboxProg);

    mainProg = createProgram(global.Shaders.MAIN_VS, global.Shaders.MAIN_FS);
    mainU = collectUniforms(mainProg);
  } catch (err) {
    showError(String(err.message || err));
    return;
  }

  /* ============================ 常量与全局状态 ============================ */

  const SHADOW_MAP_SIZE = 1024;              // shadowFBO 分辨率（1024×1024）
  const SELECTION_COLOR = [1.0, 0.72, 0.16]; // 选中高亮（橙色 Rim Light）

  const state = {
    // 着色模型与三分量
    shadingMode: 0,            // 0=Phong 1=Blinn-Phong 2=Toon（E3，全局切换便于三模型对比）
    toonLevels: 4,             // Toon 阶梯数 2~6
    enableAmbient: true,
    enableDiffuse: true,
    enableSpecular: true,
    // 方向光（太阳）
    sunAzimuth: 0,             // 度；0° = 从 +Z 方向照射（与天空盒太阳一致）
    sunElevation: 42,          // 度；高度角 5~85
    // 点光源
    pointOn: true,
    pointX: 0, pointY: 4.6, pointZ: 1.4,
    pointIntensity: 1.0,
    pointOrbit: false,         // 点光源自动环绕动画
    pointOrbitAngle: 0,
    // 阴影贴图参数（阴影相机 orthoSize / near / far / bias / PCF）
    shadowOn: true,
    shadowPCF: true,
    shadowBias: 0.0016,
    shadowSize: 14,            // 正交投影半边长（阴影相机范围）
    shadowNear: 1.0,
    shadowFar: 40.0,
    // 动画与选中
    torusSpin: true,
    selected: null,            // 当前选中的物体（object 引用）
  };

  /* ============================ 几何体与纹理 ============================ */

  const meshes = SceneGeometry.all();

  // ---- 程序化纹理上传（全部 texImage2D；UNPACK_FLIP_Y 保持默认 false） ----
  function createTexture2D(source, opts) {
    const { mipmap = true, repeat = true } = opts || {};
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // v=0 对应图像顶部（与 scene.js UV 约定一致）
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    if (mipmap) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  function createCubemap(faces) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const targets = [
      gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
    ];
    ['px', 'nx', 'py', 'ny', 'pz', 'nz'].forEach((k, i) => {
      gl.texImage2D(targets[i], 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, faces[k]);
    });
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    return tex;
  }

  function createWhiteTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1, 1);
    return createTexture2D(c, { mipmap: false, repeat: true });
  }

  const textures = {
    checker: createTexture2D(ProceduralTextures.createChecker()),
    stone: createTexture2D(ProceduralTextures.createStone()),
    brick: createTexture2D(ProceduralTextures.createBrickSet().color),
    brickNormal: createTexture2D(ProceduralTextures.createBrickNormalMap(), { mipmap: true, repeat: true }),
    cubemap: createCubemap(ProceduralTextures.createSkybox()),
    white: createWhiteTexture(),
  };

  /* ============================ VAO / 网格 ============================ */

  function createMeshVAO(mesh, attribs) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    for (const a of attribs) {
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, a.data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(a.loc);
      gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    return { vao, count: mesh.indices.length };
  }

  const fullAttribs = (m) => [
    { loc: 0, size: 3, data: m.positions },   // a_Position(0)
    { loc: 1, size: 3, data: m.normals },     // a_Normal(1)
    { loc: 2, size: 2, data: m.uvs },         // a_UV(2)
    { loc: 3, size: 3, data: m.tangents },    // a_Tangent(3)
  ];

  // 天空盒：单位立方体（仅 a_Position）
  const skyboxMesh = {
    positions: new Float32Array([
      -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,   // -Z 面
      -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,       // +Z 面
    ]),
    indices: new Uint16Array([
      0, 2, 1, 0, 3, 2,     // -Z
      4, 5, 6, 4, 6, 7,     // +Z
      4, 7, 3, 4, 3, 0,     // -X
      5, 1, 2, 5, 2, 6,     // +X
      7, 6, 2, 7, 2, 3,     // +Y
      4, 0, 1, 4, 1, 5,     // -Y
    ]),
  };
  const skyboxVAO = createMeshVAO(skyboxMesh, [{ loc: 0, size: 3, data: skyboxMesh.positions }]);

  /* ============================ 场景物体 ============================ */

  const objects = [];

  function addObject(cfg) { objects.push(cfg); return cfg; }

  function staticModel(tx, ty, tz) {
    const m = Mat4.create();
    Mat4.translate(m, m, [tx, ty, tz]);
    return m;
  }

  const floor = addObject({
    id: 1, name: 'Floor', cnName: '地面 · 棋盘纹理（接收阴影）',
    mesh: meshes.floor, tex2D: textures.checker, normalMap: null, cubeTex: null,
    pickable: true, castShadow: true,
    model: staticModel(0, 0, 0),
    material: {
      diffuseColor: [0.95, 0.93, 0.88], specularStrength: 0.12, shininess: 12,
      ambientStrength: 0.35,
      reflectionStrength: 0, alpha: 1, blend: false, selfLit: false,
      hasTex2D: true, hasNormalMap: false, receiveShadow: true,
    },
  });
  floor.getModel = function () { return this.model; };

  const crate = addObject({
    id: 2, name: 'TexturedCrate', cnName: '砖块木箱 · 2D 纹理 + 法线贴图（E1）',
    mesh: meshes.crate, tex2D: textures.brick, normalMap: textures.brickNormal, cubeTex: null,
    pickable: true, castShadow: true,
    model: staticModel(-3.4, 0.6, -2.4),
    material: {
      diffuseColor: [1, 1, 1], specularStrength: 0.25, shininess: 32,
      ambientStrength: 0.3,
      reflectionStrength: 0, alpha: 1, blend: false, selfLit: false,
      hasTex2D: true, hasNormalMap: true, receiveShadow: true,
    },
  });
  crate.getModel = function () { return this.model; };

  const sphere = addObject({
    id: 3, name: 'ReflectiveSphere', cnName: '高反射金属球 · Cubemap 环境反射（7.6）',
    mesh: meshes.sphere, tex2D: null, normalMap: null, cubeTex: textures.cubemap,
    pickable: true, castShadow: true,
    model: staticModel(2.9, 1.05, -2.3),
    material: {
      diffuseColor: [0.62, 0.66, 0.72], specularStrength: 1.2, shininess: 128,
      ambientStrength: 0.3,
      reflectionStrength: 0.85, alpha: 1, blend: false, selfLit: false,
      hasTex2D: false, hasNormalMap: false, receiveShadow: true,
    },
  });
  sphere.getModel = function () { return this.model; };

  const torus = addObject({
    id: 4, name: 'SculptureTorus', cnName: '圆环雕塑 · Phong/Blinn/Toon 对比（E3）',
    mesh: meshes.torus, tex2D: textures.stone, normalMap: null, cubeTex: null,
    pickable: true, castShadow: true,
    model: staticModel(0, 1.45, 0.25),
    spinAngle: 0,
    material: {
      diffuseColor: [0.92, 0.88, 0.82], specularStrength: 0.7, shininess: 56,
      ambientStrength: 0.35,
      reflectionStrength: 0, alpha: 1, blend: false, selfLit: false,
      hasTex2D: true, hasNormalMap: false, receiveShadow: true,
    },
  });
  torus.getModel = function () {
    const m = Mat4.create();
    Mat4.rotateY(m, this.model, this.spinAngle);
    return m;
  };

  const pillar = addObject({
    id: 5, name: 'Pillar', cnName: '八角石柱 · 投射阴影（观察锯齿/漏光）',
    mesh: meshes.pillar, tex2D: textures.stone, normalMap: null, cubeTex: null,
    pickable: true, castShadow: true,
    model: staticModel(4.3, 0, 3.1),
    material: {
      diffuseColor: [1, 1, 1], specularStrength: 0.3, shininess: 24,
      ambientStrength: 0.35,
      reflectionStrength: 0, alpha: 1, blend: false, selfLit: false,
      hasTex2D: true, hasNormalMap: false, receiveShadow: true,
    },
  });
  pillar.getModel = function () { return this.model; };

  const pyramid = addObject({
    id: 6, name: 'GlassPyramid', cnName: '玻璃方尖碑 · Alpha Blend 透明（E2）',
    mesh: meshes.pyramid, tex2D: null, normalMap: null, cubeTex: null,
    pickable: true, castShadow: false,   // 玻璃不参与实体阴影
    model: staticModel(-4.2, 0, 2.9),
    material: {
      diffuseColor: [0.60, 0.85, 0.95], specularStrength: 1.4, shininess: 128,
      ambientStrength: 0.35,
      reflectionStrength: 0, alpha: 0.45, blend: true, selfLit: false,
      hasTex2D: false, hasNormalMap: false, receiveShadow: true,
    },
  });
  pyramid.getModel = function () { return this.model; };

  // 点光源可视化标记（自发光小球，不可拾取、不投影、不接收阴影）
  const lightMarker = addObject({
    id: 0, name: 'LightMarker', cnName: '点光源标记',
    mesh: meshes.sphere, tex2D: null, normalMap: null, cubeTex: null,
    pickable: false, castShadow: false,
    model: Mat4.create(),
    material: {
      diffuseColor: [1.0, 0.85, 0.5], specularStrength: 0, shininess: 1,
      ambientStrength: 1.0,
      reflectionStrength: 0, alpha: 1, blend: false, selfLit: true,
      hasTex2D: false, hasNormalMap: false, receiveShadow: false,
    },
  });
  lightMarker.getModel = function () {
    const m = Mat4.create();
    Mat4.translate(m, m, [state.pointX, state.pointY, state.pointZ]);
    Mat4.scale(m, m, [0.12, 0.12, 0.12]);
    return m;
  };

  for (const obj of objects) {
    obj.vao = createMeshVAO(obj.mesh, fullAttribs(obj.mesh));
  }

  /* ============================ FBO 创建 ============================ */

  /** 阴影 FBO：1024×1024，RGBA 颜色附件（阴影贴图）+ 深度 Renderbuffer */
  function createShadowFBO() {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // 深度打包进 RGBA：必须 NEAREST（线性滤波会混叠各通道字节，破坏解包）
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    const depthRB = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRB);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRB);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('shadowFBO 不完整：0x' + status.toString(16));

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, depthRB };
  }

  const shadowFBO = createShadowFBO();

  /** 拾取 FBO：与画布同尺寸（resize 时重建） */
  let pickFBO = null;

  function createPickFBO(w, h) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    const depthRB = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRB);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRB);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('pickFBO 不完整：0x' + status.toString(16));

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, depthRB };
  }

  function ensurePickFBO() {
    if (pickFBO) return pickFBO;
    pickFBO = createPickFBO(Math.max(1, canvas.width), Math.max(1, canvas.height));
    return pickFBO;
  }

  /* ============================ 相机 ============================ */

  const camera = {
    target: [0, 1.4, 0],
    azimuth: 0.62,
    elevation: 0.34,
    distance: 12.5,
    fov: Math.PI / 4,
  };
  const CAMERA_DEFAULTS = {
    azimuth: 0.62, elevation: 0.34, distance: 12.5,
  };

  function cameraEye() {
    const ce = Math.cos(camera.elevation), se = Math.sin(camera.elevation);
    return [
      camera.target[0] + camera.distance * ce * Math.sin(camera.azimuth),
      camera.target[1] + camera.distance * se,
      camera.target[2] + camera.distance * ce * Math.cos(camera.azimuth),
    ];
  }

  function resetCamera() {
    camera.azimuth = CAMERA_DEFAULTS.azimuth;
    camera.elevation = CAMERA_DEFAULTS.elevation;
    camera.distance = CAMERA_DEFAULTS.distance;
    camera.target = [0, 1.4, 0];   // 目标点一并还原
  }

  /* ============================ 每帧矩阵与光源 ============================ */

  const viewMatrix = Mat4.create();
  const projMatrix = Mat4.create();
  const viewProjMatrix = Mat4.create();
  const skyboxViewMatrix = Mat4.create();
  const skyboxVPMatrix = Mat4.create();
  const lightSpaceMatrix = Mat4.create();
  const normalScratch = new Float32Array(9);
  const model3Scratch = new Float32Array(9);
  const eyePos = Vec3.create();
  const lightDir = Vec3.create();

  /** 方向光传播方向（由方位角/高度角决定；0° 方位角 = 从 +Z 照射，与天空盒太阳一致） */
  function lightDirection() {
    const az = helpers.degToRad(state.sunAzimuth);
    const el = helpers.degToRad(state.sunElevation);
    return [
      -Math.sin(az) * Math.cos(el),
      -Math.sin(el),
      -Math.cos(az) * Math.cos(el),
    ];
  }

  /** 光源空间 View*Ortho（阴影相机：方位角/高度角/orthoSize/near/far 均可经面板调节） */
  function computeLightSpaceMatrix() {
    const dir = lightDirection();
    const center = [0, 1.2, 0];
    const eye = [
      center[0] - dir[0] * 18,
      center[1] - dir[1] * 18,
      center[2] - dir[2] * 18,
    ];
    const view = Mat4.lookAt(Mat4.create(), eye, center, [0, 1, 0]);
    const s = state.shadowSize;
    const proj = Mat4.ortho(Mat4.create(), -s, s, -s, s, state.shadowNear, state.shadowFar);
    return Mat4.multiply(Mat4.create(), proj, view);
  }

  function updateFrame(dt) {
    if (state.torusSpin) torus.spinAngle += dt * 0.55;

    // 点光源自动环绕动画（双向绑定：动画写回滑块显示）
    if (state.pointOrbit) {
      state.pointOrbitAngle += dt * 0.6;
      state.pointX = 4.2 * Math.cos(state.pointOrbitAngle);
      state.pointZ = 4.2 * Math.sin(state.pointOrbitAngle);
      if (pointXRef) pointXRef.set(state.pointX.toFixed(1));
      if (pointZRef) pointZRef.set(state.pointZ.toFixed(1));
    }

    const eye = cameraEye();
    Vec3.copy(eyePos, eye);
    Mat4.lookAt(viewMatrix, eye, camera.target, [0, 1, 0]);
    Mat4.perspective(projMatrix, camera.fov, canvas.width / Math.max(1, canvas.height), 0.1, 120);
    Mat4.multiply(viewProjMatrix, projMatrix, viewMatrix);

    // 天空盒视图：去掉平移分量（天空盒永远以相机为中心）
    Mat4.copy(skyboxViewMatrix, viewMatrix);
    skyboxViewMatrix[12] = 0; skyboxViewMatrix[13] = 0; skyboxViewMatrix[14] = 0;
    Mat4.multiply(skyboxVPMatrix, projMatrix, skyboxViewMatrix);

    Mat4.copy(lightSpaceMatrix, computeLightSpaceMatrix());
    Vec3.copy(lightDir, lightDirection());
  }

  /* ============================ Pass 1：阴影遍 ============================ */

  function renderShadowPass() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFBO.fbo);
    gl.viewport(0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    gl.clearColor(1, 1, 1, 1);          // 深度 1 = 最远（无阴影区域）
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);              // 剔除朝向光源的面，减轻 peter-panning（阴影偏移）

    gl.useProgram(shadowProg);
    gl.uniformMatrix4fv(shadowU.u_LightSpaceMatrix, false, lightSpaceMatrix);
    for (const obj of objects) {
      if (!obj.castShadow) continue;
      gl.uniformMatrix4fv(shadowU.u_ModelMatrix, false, obj.getModel());
      gl.bindVertexArray(obj.vao.vao);
      gl.drawElements(gl.TRIANGLES, obj.vao.count, gl.UNSIGNED_SHORT, 0);
    }

    gl.cullFace(gl.BACK);
    gl.bindVertexArray(null);
  }

  /* ============================ Pass 2：主光照遍 ============================ */

  function setMainUniforms(obj) {
    const u = mainU;
    const model = obj.getModel();
    const mat = obj.material;
    const selfLit = mat.selfLit === true;

    Mat4.normalMatrix(normalScratch, model);
    Mat4.toMat3(model3Scratch, model);

    gl.uniformMatrix4fv(u.u_ModelMatrix, false, model);
    gl.uniformMatrix4fv(u.u_ViewMatrix, false, viewMatrix);
    gl.uniformMatrix4fv(u.u_ProjMatrix, false, projMatrix);
    gl.uniformMatrix4fv(u.u_LightSpaceMatrix, false, lightSpaceMatrix);
    gl.uniformMatrix3fv(u.u_NormalMatrix, false, normalScratch);
    gl.uniformMatrix3fv(u.u_ModelMat3, false, model3Scratch);

    gl.uniform3fv(u.u_CameraPos, eyePos);

    // 方向光（主光源，产生阴影）；selfLit 物体仅取环境项呈现自发光
    gl.uniform3f(u['u_DirLight.direction'], lightDir[0], lightDir[1], lightDir[2]);
    gl.uniform3f(u['u_DirLight.color'], 1.0, selfLit ? 1.0 : 0.97, selfLit ? 1.0 : 0.92);

    // 点光源（距离衰减；pointOn 关闭时强度归零）
    const pointScale = state.pointOn ? state.pointIntensity : 0.0;
    gl.uniform3f(u['u_PointLight.position'], state.pointX, state.pointY, state.pointZ);
    gl.uniform3f(u['u_PointLight.color'],
      1.0 * pointScale, 0.9 * pointScale, 0.72 * pointScale);
    gl.uniform1f(u['u_PointLight.constant'], 1.0);
    gl.uniform1f(u['u_PointLight.linear'], 0.10);
    gl.uniform1f(u['u_PointLight.quadratic'], 0.03);

    // Phong 三分量独立开关与材质参数
    gl.uniform1i(u.u_EnableAmbient, selfLit ? 1 : (state.enableAmbient ? 1 : 0));
    gl.uniform1f(u.u_AmbientStrength, selfLit ? 1.0 : mat.ambientStrength);
    gl.uniform1i(u.u_EnableDiffuse, selfLit ? 0 : (state.enableDiffuse ? 1 : 0));
    gl.uniform1i(u.u_EnableSpecular, selfLit ? 0 : (state.enableSpecular ? 1 : 0));
    gl.uniform3fv(u.u_DiffuseColor, mat.diffuseColor);
    gl.uniform1f(u.u_SpecularStrength, mat.specularStrength);
    gl.uniform1f(u.u_Shininess, mat.shininess);

    // 着色模型（E3）
    gl.uniform1i(u.u_ShadingMode, state.shadingMode);
    gl.uniform1i(u.u_ToonLevels, state.toonLevels);

    // ---- 纹理单元固定分配（避免串扰：每次绘制都显式绑定全部四个单元） ----
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, (mat.hasTex2D && obj.tex2D) ? obj.tex2D : textures.white);
    gl.uniform1i(u.u_Tex2D, 0);

    gl.activeTexture(gl.TEXTURE1);
    if (obj.cubeTex) gl.bindTexture(gl.TEXTURE_CUBE_MAP, obj.cubeTex);
    else gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    gl.uniform1i(u.u_CubeMap, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, shadowFBO.tex);
    gl.uniform1i(u.u_ShadowMap, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, (mat.hasNormalMap && obj.normalMap) ? obj.normalMap : textures.white);
    gl.uniform1i(u.u_NormalMap, 3);

    gl.uniform1i(u.u_HasTex2D, (mat.hasTex2D && obj.tex2D) ? 1 : 0);
    gl.uniform1i(u.u_HasCubeMap, obj.cubeTex ? 1 : 0);
    gl.uniform1i(u.u_HasNormalMap, (mat.hasNormalMap && obj.normalMap) ? 1 : 0);
    gl.uniform1f(u.u_ReflectionStrength, mat.reflectionStrength);

    // 阴影（教材 8.8）
    gl.uniform1i(u.u_ReceiveShadow, (!selfLit && mat.receiveShadow && state.shadowOn) ? 1 : 0);
    gl.uniform1i(u.u_ShadowPCF, state.shadowPCF ? 1 : 0);
    gl.uniform1f(u.u_ShadowBias, state.shadowBias);
    gl.uniform1f(u.u_ShadowMapSize, SHADOW_MAP_SIZE);

    // 拾取高亮与透明度
    gl.uniform1i(u.u_IsSelected, (state.selected === obj) ? 1 : 0);
    gl.uniform3fv(u.u_SelectionColor, SELECTION_COLOR);
    gl.uniform1f(u.u_Alpha, mat.blend ? mat.alpha : 1.0);
  }

  function drawMainObject(obj) {
    setMainUniforms(obj);
    if (obj.material.blend) {
      // 选做 E2：半透明物体 —— 开启 Alpha 混合、关闭深度写入、双面渲染
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
    } else {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
    }
    gl.bindVertexArray(obj.vao.vao);
    gl.drawElements(gl.TRIANGLES, obj.vao.count, gl.UNSIGNED_SHORT, 0);
  }

  function renderMainPass() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.10, 0.12, 0.16, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);

    // ---- 天空盒（不写深度，NDC 深度恒为 1，位于最远） ----
    gl.useProgram(skyboxProg);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, textures.cubemap);
    gl.uniform1i(skyboxU.u_CubeMap, 1);
    gl.uniformMatrix4fv(skyboxU.u_ViewProjMatrix, false, skyboxVPMatrix);
    gl.bindVertexArray(skyboxVAO.vao);
    gl.drawElements(gl.TRIANGLES, skyboxVAO.count, gl.UNSIGNED_SHORT, 0);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // ---- 不透明物体（关闭 BLEND、开启深度写入） ----
    gl.useProgram(mainProg);
    for (const obj of objects) {
      if (!obj.material.blend) drawMainObject(obj);
    }

    // ---- 透明物体（E2 Alpha Blend，最后渲染） ----
    for (const obj of objects) {
      if (obj.material.blend) drawMainObject(obj);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }

  /* ============================ 主循环 ============================ */

  let lastTime = performance.now();
  let fpsSmooth = 60;        // FPS 指数滑动平均
  let lastFpsUpdate = 0;

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    updateFrame(dt);
    renderShadowPass();   // Pass 1：阴影贴图
    renderMainPass();     // Pass 2：天空盒 + 主光照（不透明→透明）

    // FPS 统计（指数滑动平均，每 500ms 刷新一次状态栏）
    if (dt > 1e-4) {
      fpsSmooth = fpsSmooth * 0.92 + (1.0 / dt) * 0.08;
      if (now - lastFpsUpdate > 500) {
        lastFpsUpdate = now;
        if (fpsEl) fpsEl.textContent = fpsSmooth.toFixed(1);
      }
    }
    requestAnimationFrame(frame);
  }

  /* ============================ 鼠标拾取（教材 3.9） ============================ */

  let selectedObjectId = 0;   // 0 = 未选中（背景）

  function selectObject(obj) {
    state.selected = obj || null;
    selectedObjectId = obj ? obj.id : 0;
    // 顶部状态栏同步显示选中物体名称
    if (selectedNameEl) {
      selectedNameEl.innerHTML = obj
        ? '当前选中：<b>' + obj.name + '</b> <span class="dim">[' + obj.cnName.split('·')[0] + ']</span>'
        : '当前选中：<span class="dim">无 [点击场景物体可切换]</span>';
    }
    refreshMaterialPanel(obj);
  }

  function pickObject(clientX, clientY) {
    const fbo = ensurePickFBO();
    const w = canvas.width, h = canvas.height;

    // 在 pickFBO 中重绘场景：每个物体输出唯一 ID 颜色
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);            // 0 号色 = 背景（未选中）
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    gl.useProgram(pickProg);
    gl.uniformMatrix4fv(pickU.u_ViewProjMatrix, false, viewProjMatrix);
    for (const obj of objects) {
      if (!obj.pickable) continue;
      gl.uniform4f(pickU.u_PickColor, obj.id / 255, 0, 0, 1);   // ID 编码进 R 通道
      gl.uniformMatrix4fv(pickU.u_ModelMatrix, false, obj.getModel());
      if (obj.material.blend) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
      gl.bindVertexArray(obj.vao.vao);
      gl.drawElements(gl.TRIANGLES, obj.vao.count, gl.UNSIGNED_SHORT, 0);
    }

    // 读回点击像素（注意画布坐标 y 轴翻转与 devicePixelRatio）
    const dpr = window.devicePixelRatio || 1;
    const px = clamp(Math.round(clientX * dpr), 0, w - 1);
    const py = clamp(h - 1 - Math.round(clientY * dpr), 0, h - 1);
    const data = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(null);

    const id = data[0];   // R 通道字节值即物体 ID（0 = 背景，未选中）
    const obj = objects.find(o => o.id === id) || null;
    selectObject(obj);
  }

  /* ============================ UI 双向绑定 ============================ */

  function bindRange(id, onChange) {
    const el = $(id);
    const out = $(id + 'Val');
    if (!el) return null;
    const apply = () => {
      if (out) out.textContent = el.value;
      onChange(parseFloat(el.value));
    };
    el.addEventListener('input', apply);
    return { el, set(v) { el.value = v; if (out) out.textContent = el.value; } };
  }

  function bindCheck(id, onChange) {
    const el = $(id);
    if (!el) return null;
    const apply = () => onChange(el.checked);
    el.addEventListener('change', apply);
    return { el, set(v) { el.checked = !!v; } };
  }

  function bindSelect(id, onChange) {
    const el = $(id);
    if (!el) return null;
    const apply = () => onChange(parseInt(el.value, 10));
    el.addEventListener('change', apply);
    return { el, set(v) { el.value = String(v); } };
  }

  function rgbToHex(rgb) {
    const to2 = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
    return '#' + to2(rgb[0]) + to2(rgb[1]) + to2(rgb[2]);
  }

  function hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255,
    ];
  }

  /** 选中物体变化 → 重建材质面板（状态 → UI 方向） */
  function refreshMaterialPanel(obj) {
    const box = $('materialControls');
    if (!box) return;
    if (!obj) {
      box.innerHTML = '<p class="hint">点击场景中的物体以编辑其材质参数<br>（选中物体带橙色边缘发光高亮）</p>';
      return;
    }
    const mat = obj.material;

    let html = '<p class="obj-name">' + obj.cnName + '</p>';
    html += '<label>漫反射颜色 <input type="color" id="mat-diffuse"></label>';
    html += '<label>环境光系数 <output id="mat-ambientVal"></output><input type="range" id="mat-ambient" min="0" max="1" step="0.01"></label>';
    html += '<label>镜面强度 <output id="mat-specVal"></output><input type="range" id="mat-spec" min="0" max="2" step="0.01"></label>';
    html += '<label>高光指数 <output id="mat-shininessVal"></output><input type="range" id="mat-shininess" min="1" max="256" step="1"></label>';
    if (obj.cubeTex) {
      html += '<label>环境反射强度 <output id="mat-reflVal"></output><input type="range" id="mat-refl" min="0" max="1" step="0.01"></label>';
    }
    if (mat.blend) {
      html += '<label>不透明度（E2） <output id="mat-alphaVal"></output><input type="range" id="mat-alpha" min="0.05" max="1" step="0.01"></label>';
    }
    if (obj.tex2D) {
      html += '<label><input type="checkbox" id="mat-tex"> 使用 2D 纹理</label>';
    }
    if (obj.normalMap) {
      html += '<label><input type="checkbox" id="mat-normal"> 法线贴图（E1 凹凸对比）</label>';
    }
    html += '<label><input type="checkbox" id="mat-shadow"> 接收阴影</label>';
    box.innerHTML = html;

    // 颜色控件
    const colorEl = $('mat-diffuse');
    colorEl.value = rgbToHex(mat.diffuseColor);
    colorEl.addEventListener('input', () => { mat.diffuseColor = hexToRgb(colorEl.value); });

    // 滑块与开关（UI → 状态方向：直接写入选中物体材质）
    if ($('mat-ambient')) bindRange('mat-ambient', v => { mat.ambientStrength = v; }).set(mat.ambientStrength);
    if ($('mat-spec')) bindRange('mat-spec', v => { mat.specularStrength = v; }).set(mat.specularStrength);
    if ($('mat-shininess')) bindRange('mat-shininess', v => { mat.shininess = Math.round(v); }).set(mat.shininess);
    if ($('mat-refl')) bindRange('mat-refl', v => { mat.reflectionStrength = v; }).set(mat.reflectionStrength);
    if ($('mat-alpha')) bindRange('mat-alpha', v => { mat.alpha = v; }).set(mat.alpha);
    if ($('mat-tex')) bindCheck('mat-tex', v => { mat.hasTex2D = v; }).set(mat.hasTex2D);
    if ($('mat-normal')) bindCheck('mat-normal', v => { mat.hasNormalMap = v; }).set(mat.hasNormalMap);
    if ($('mat-shadow')) bindCheck('mat-shadow', v => { mat.receiveShadow = v; }).set(mat.receiveShadow);
  }

  /* ---------- 全局面板绑定 ---------- */

  const shadingSelect = bindSelect('shadeMode', v => { state.shadingMode = v; });
  bindRange('toonLevels', v => { state.toonLevels = Math.round(clamp(v, 2, 6)); });

  // 三分量开关（保存引用供预设按钮同步 checkbox 显示）
  const ambientCheckRef = bindCheck('enableAmbient', v => { state.enableAmbient = v; });
  const diffuseCheckRef = bindCheck('enableDiffuse', v => { state.enableDiffuse = v; });
  const specularCheckRef = bindCheck('enableSpecular', v => { state.enableSpecular = v; });

  /** 三分量快捷预设（一键切换开关状态，方便对比截图；同步勾选框显示） */
  function applyPreset(ambient, diffuse, specular) {
    state.enableAmbient = ambient;
    state.enableDiffuse = diffuse;
    state.enableSpecular = specular;
    if (ambientCheckRef) ambientCheckRef.set(ambient);
    if (diffuseCheckRef) diffuseCheckRef.set(diffuse);
    if (specularCheckRef) specularCheckRef.set(specular);
  }
  const presetEl = $('preset-ambient');
  if (presetEl) presetEl.addEventListener('click', () => applyPreset(true, false, false));
  const presetEl2 = $('preset-diffuse');
  if (presetEl2) presetEl2.addEventListener('click', () => applyPreset(false, true, false));
  const presetEl3 = $('preset-specular');
  if (presetEl3) presetEl3.addEventListener('click', () => applyPreset(false, false, true));
  const presetEl4 = $('preset-all');
  if (presetEl4) presetEl4.addEventListener('click', () => applyPreset(true, true, true));

  bindRange('sunAzimuth', v => { state.sunAzimuth = v; });
  bindRange('sunElevation', v => { state.sunElevation = v; });

  bindCheck('pointOn', v => { state.pointOn = v; });
  const pointXRef = bindRange('pointX', v => { state.pointX = v; });
  bindRange('pointY', v => { state.pointY = v; });
  const pointZRef = bindRange('pointZ', v => { state.pointZ = v; });
  bindRange('pointIntensity', v => { state.pointIntensity = v; });
  bindCheck('pointOrbit', v => { state.pointOrbit = v; });

  bindCheck('shadowOn', v => { state.shadowOn = v; });
  bindCheck('shadowPCF', v => { state.shadowPCF = v; });
  bindRange('shadowBias', v => { state.shadowBias = v; });
  bindRange('shadowSize', v => { state.shadowSize = v; });
  bindRange('shadowNear', v => { state.shadowNear = v; });
  bindRange('shadowFar', v => { state.shadowFar = v; });

  bindCheck('torusSpin', v => { state.torusSpin = v; });

  /* ---------- 顶部状态栏与面板折叠 ---------- */

  const fpsEl = $('fpsValue');
  const selectedNameEl = $('selectedName');

  const panelToggle = $('panelToggle');
  if (panelToggle) {
    panelToggle.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('panel-collapsed');
      panelToggle.textContent = collapsed ? '◀' : '▶';
    });
  }

  /* ============================ 鼠标 / 键盘交互 ============================ */

  let dragging = false;
  let moved = false;
  let downX = 0, downY = 0, lastX = 0, lastY = 0;

  canvas.addEventListener('mousedown', (e) => {
    dragging = true;
    moved = false;
    downX = e.clientX; downY = e.clientY;
    lastX = e.clientX; lastY = e.clientY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) moved = true;   // 位移 > 5px 视为拖拽旋转
    if (moved) {
      camera.azimuth -= dx * 0.008;
      camera.elevation = clamp(camera.elevation + dy * 0.008, -0.1, 1.45);
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (dragging && !moved) {                 // 位移 < 5px → 视为单击拾取
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x >= 0 && y >= 0 && x <= rect.width && y <= rect.height) {
        pickObject(x, y);
      }
    }
    dragging = false;
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.distance = clamp(camera.distance * Math.exp(e.deltaY * 0.0012), 4, 26);
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.key === '1' || e.key === '2' || e.key === '3') {
      const v = parseInt(e.key, 10) - 1;
      state.shadingMode = v;
      if (shadingSelect) shadingSelect.set(v);
    } else if (e.key === 'r' || e.key === 'R') {
      resetCamera();
    }
  });

  /* ============================ 尺寸与启动 ============================ */

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * (window.devicePixelRatio || 1)));
    canvas.height = Math.max(1, Math.round(h * (window.devicePixelRatio || 1)));
    if (pickFBO) {                           // 尺寸变化后重建拾取 FBO
      gl.deleteFramebuffer(pickFBO.fbo);
      gl.deleteTexture(pickFBO.tex);
      gl.deleteRenderbuffer(pickFBO.depthRB);
      pickFBO = null;
    }
  }

  window.addEventListener('resize', resize);
  resize();

  selectObject(null);          // 初始无选中
  console.log('[AP3] 初始化完成：WebGL2 上下文就绪，' + objects.length + ' 个物体，阴影贴图 ' +
    SHADOW_MAP_SIZE + '×' + SHADOW_MAP_SIZE + '。');
  requestAnimationFrame(frame);

  /* ============================ 自动化验证接口（调试用） ============================ */

  global.__AP3 = {
    state, objects, camera, gl, canvas,
    pickObject, resetCamera,
    setShadingMode(v) { state.shadingMode = v; if (shadingSelect) shadingSelect.set(v); },
    /** 模型空间点 → 画布 CSS 像素坐标（供自动化点击拾取测试与 README 截图脚本使用） */
    projectToScreen(obj, worldPt) {
      const p = Vec3.create();
      Vec3.transformMat4(p, worldPt, obj.getModel());
      const m = viewProjMatrix;
      const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      const cx = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w;
      const cy = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
      const dpr = window.devicePixelRatio || 1;
      return {
        x: (cx * 0.5 + 0.5) * canvas.width / dpr,
        y: (1 - (cy * 0.5 + 0.5)) * canvas.height / dpr,
        ndc: [cx, cy],
      };
    },
  };
})(typeof window !== 'undefined' ? window : this);
