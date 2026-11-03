'use strict';

/**
 * ============================================================================
 *  AP3 · 光照与纹理场景 —— scene.js（第一阶段交付）
 *  轻量矩阵/向量数学库 + 6 个几何体网格生成 + Canvas 程序化纹理生成器
 * ============================================================================
 *
 *  一、Mesh 数据结构契约（与 main.js 一致）
 *    {
 *      name:      string,         // 物体名（用于 UI / 拾取 ID 映射）
 *      positions: Float32Array,   // 顶点坐标 xyz
 *      normals:   Float32Array,   // 法线 xyz
 *      uvs:       Float32Array,   // 纹理坐标 xy
 *      tangents:  Float32Array,   // 切线 xyz（选做 E1 法线贴图用）
 *      indices:   Uint16Array,    // 三角形索引（gl.TRIANGLES）
 *    }
 *    与 shaders.js 中 layout(location) 固定的顶点属性一一对应：
 *      a_Position(0) ← positions, a_Normal(1) ← normals,
 *      a_UV(2) ← uvs,  a_Tangent(3) ← tangents
 *    （main.js 据此建立 VAO/VBO；索引经 gl.drawElements 提交）
 *    UV 约定：v=0 对应纹理图像（canvas）顶部 —— 上传保持 WebGL 默认
 *    UNPACK_FLIP_Y_WEBGL=false，各几何体已按此约定生成 UV。
 *
 *  二、场景主题：庭院（courtyard）
 *     1. Floor          大地面 —— 接收阴影 + 棋盘网格纹理（UV 重复平铺）
 *     2. TexturedCrate  木箱/砖块立方体 —— 2D 砖墙纹理 + E1 法线凹凸贴图
 *     3. ReflectiveSphere 高反射金属球 —— Cubemap 环境反射（教材 7.6）
 *     4. SculptureTorus 中心圆环雕塑 —— 光滑着色，重点展示
 *                        Phong / Blinn-Phong / Toon 三种模型对比（E3）
 *     5. Pillar         八角石柱 —— 投射明显阴影（观察锯齿/漏光）
 *     6. GlassPyramid   半透明水晶方尖碑 —— E2 Alpha Blend 混合
 *
 *  三、程序化纹理（全部离屏 <canvas> 绘制，无任何外部图片 / CORS 依赖，
 *     直接交给 main.js 调用 gl.texImage2D 上传）：
 *     createChecker()        棋盘/网格纹理（地面，REPEAT 平铺）
 *     createBrickSet()       砖墙 2D 纹理 + 与之一一对应的 RGB 法线贴图
 *     createBrickNormalMap() 砖墙法线贴图（E1，与颜色纹理严格对齐）
 *     createStone()          程序化石材纹理（石柱，附加）
 *     createSkybox()         6 面 Cubemap：渐变天空 + 太阳 + 地平线网格
 *
 *  四、数学库（自实现，不依赖外部失效 CDN；列主序存储，与 gl.uniformMatrix*
 *     / WebGL 约定一致）：
 *     Mat4.perspective / ortho / lookAt / multiply / translate / rotateX/Y/Z /
 *     scale / invert / transpose / normalMatrix / toMat3
 *     Vec3.add / subtract / scale / dot / cross / normalize / transformMat4 等
 *     （功能对标教材配套 MV.js，便于 main.js 复用与 README 讲解矩阵推导）
 * ============================================================================
 */

(function (global) {

  /* ============================ 通用小工具 ============================ */

  function degToRad(d) { return d * Math.PI / 180; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /** 确定性伪随机数生成器（mulberry32）：同一 seed 每次生成完全相同的纹理 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ============================ 1. Vec3 ============================ */

  const Vec3 = {
    create(x = 0, y = 0, z = 0) { return [x, y, z]; },
    copy(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; },
    set(out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; return out; },
    add(out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; return out; },
    subtract(out, a, b) { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out; },
    scale(out, a, s) { out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; return out; },
    dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross(out, a, b) {
      const x = a[1] * b[2] - a[2] * b[1];
      const y = a[2] * b[0] - a[0] * b[2];
      const z = a[0] * b[1] - a[1] * b[0];
      out[0] = x; out[1] = y; out[2] = z;
      return out;
    },
    length(a) { return Math.hypot(a[0], a[1], a[2]); },
    normalize(out, a) {
      const len = Vec3.length(a);
      if (len < 1e-10) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
      out[0] = a[0] / len; out[1] = a[1] / len; out[2] = a[2] / len;
      return out;
    },
    /** 点变换（w=1，含透视除法） */
    transformMat4(out, a, m) {
      const x = a[0], y = a[1], z = a[2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1.0;
      out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
      return out;
    },
    /** 方向变换（w=0，不施加平移） */
    transformDir(out, a, m) {
      const x = a[0], y = a[1], z = a[2];
      out[0] = m[0] * x + m[4] * y + m[8] * z;
      out[1] = m[1] * x + m[5] * y + m[9] * z;
      out[2] = m[2] * x + m[6] * y + m[10] * z;
      return out;
    },
  };

  /* ============================ 2. Mat4（列主序） ============================ */

  const Mat4 = {
    create() {
      const out = new Float32Array(16);
      out[0] = out[5] = out[10] = out[15] = 1;
      return out;
    },
    identity(out) {
      out.fill(0);
      out[0] = out[5] = out[10] = out[15] = 1;
      return out;
    },
    copy(out, a) { out.set(a); return out; },

    /** 透视投影（fovy 为弧度） */
    perspective(out, fovy, aspect, near, far) {
      const f = 1.0 / Math.tan(fovy / 2);
      out.fill(0);
      out[0] = f / aspect;
      out[5] = f;
      out[10] = (far + near) / (near - far);
      out[11] = -1.0;
      out[14] = (2.0 * far * near) / (near - far);
      return out;
    },

    /** 正交投影（阴影贴图第一遍使用，深度与视深线性相关） */
    ortho(out, left, right, bottom, top, near, far) {
      out.fill(0);
      out[0] = 2.0 / (right - left);
      out[5] = 2.0 / (top - bottom);
      out[10] = -2.0 / (far - near);
      out[12] = -(right + left) / (right - left);
      out[13] = -(top + bottom) / (top - bottom);
      out[14] = -(far + near) / (far - near);
      out[15] = 1.0;
      return out;
    },

    /** 视图矩阵（右手系） */
    lookAt(out, eye, center, up) {
      let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
      let len = Math.hypot(zx, zy, zz);
      if (len < 1e-10) { zx = 0; zy = 0; zz = 1; len = 1; }
      zx /= len; zy /= len; zz /= len;

      let xx = up[1] * zz - up[2] * zy;   // x = up × z
      let xy = up[2] * zx - up[0] * zz;
      let xz = up[0] * zy - up[1] * zx;
      len = Math.hypot(xx, xy, xz);
      if (len < 1e-10) { xx = 1; xy = 0; xz = 0; len = 1; }
      xx /= len; xy /= len; xz /= len;

      const yx = zy * xz - zz * xy;       // y = z × x
      const yy = zz * xx - zx * xz;
      const yz = zx * xy - zy * xx;

      out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
      out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
      out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
      out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
      out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
      out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
      out[15] = 1;
      return out;
    },

    /** out = a × b（列主序） */
    multiply(out, a, b) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

      let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
      out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

      b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
      out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

      b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
      out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

      b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
      out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      return out;
    },

    translate(out, a, v) {
      const x = v[0], y = v[1], z = v[2];
      if (a === out) {
        out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
        out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
        out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
        out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
      } else {
        const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
        const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
        const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
        out[0] = a00; out[1] = a01; out[2] = a02; out[3] = a03;
        out[4] = a10; out[5] = a11; out[6] = a12; out[7] = a13;
        out[8] = a20; out[9] = a21; out[10] = a22; out[11] = a23;
        out[12] = a00 * x + a10 * y + a20 * z + a[12];
        out[13] = a01 * x + a11 * y + a21 * z + a[13];
        out[14] = a02 * x + a12 * y + a22 * z + a[14];
        out[15] = a03 * x + a13 * y + a23 * z + a[15];
      }
      return out;
    },

    scale(out, a, v) {
      const x = v[0], y = v[1], z = v[2];
      out[0] = a[0] * x; out[1] = a[1] * x; out[2] = a[2] * x; out[3] = a[3] * x;
      out[4] = a[4] * y; out[5] = a[5] * y; out[6] = a[6] * y; out[7] = a[7] * y;
      out[8] = a[8] * z; out[9] = a[9] * z; out[10] = a[10] * z; out[11] = a[11] * z;
      out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
      return out;
    },

    rotateX(out, a, rad) {
      const s = Math.sin(rad), c = Math.cos(rad);
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      if (a !== out) {
        out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
      }
      out[4] = a10 * c + a20 * s;
      out[5] = a11 * c + a21 * s;
      out[6] = a12 * c + a22 * s;
      out[7] = a13 * c + a23 * s;
      out[8] = a20 * c - a10 * s;
      out[9] = a21 * c - a11 * s;
      out[10] = a22 * c - a12 * s;
      out[11] = a23 * c - a13 * s;
      return out;
    },

    rotateY(out, a, rad) {
      const s = Math.sin(rad), c = Math.cos(rad);
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      if (a !== out) {
        out[4] = a[4]; out[5] = a[5]; out[6] = a[6]; out[7] = a[7];
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
      }
      out[0] = a00 * c - a20 * s;
      out[1] = a01 * c - a21 * s;
      out[2] = a02 * c - a22 * s;
      out[3] = a03 * c - a23 * s;
      out[8] = a00 * s + a20 * c;
      out[9] = a01 * s + a21 * c;
      out[10] = a02 * s + a22 * c;
      out[11] = a03 * s + a23 * c;
      return out;
    },

    rotateZ(out, a, rad) {
      const s = Math.sin(rad), c = Math.cos(rad);
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      if (a !== out) {
        out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11];
        out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15];
      }
      out[0] = a00 * c + a10 * s;
      out[1] = a01 * c + a11 * s;
      out[2] = a02 * c + a12 * s;
      out[3] = a03 * c + a13 * s;
      out[4] = a10 * c - a00 * s;
      out[5] = a11 * c - a01 * s;
      out[6] = a12 * c - a02 * s;
      out[7] = a13 * c - a03 * s;
      return out;
    },

    /** 4x4 一般逆矩阵（Gauss 消元，稳健） */
    invert(out, a) {
      let a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      let a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      let a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      let a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

      const b00 = a00 * a11 - a01 * a10;
      const b01 = a00 * a12 - a02 * a10;
      const b02 = a00 * a13 - a03 * a10;
      const b03 = a01 * a12 - a02 * a11;
      const b04 = a01 * a13 - a03 * a11;
      const b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30;
      const b07 = a20 * a32 - a22 * a30;
      const b08 = a20 * a33 - a23 * a30;
      const b09 = a21 * a32 - a22 * a31;
      const b10 = a21 * a33 - a23 * a31;
      const b11 = a22 * a33 - a23 * a32;

      let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return null;   // 奇异矩阵
      det = 1.0 / det;

      out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
      out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
      out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
      out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
      out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
      out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
      out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
      out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
      out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return out;
    },

    transpose(out, a) {
      if (out === a) {
        const a01 = a[1], a02 = a[2], a03 = a[3];
        const a12 = a[6], a13 = a[7];
        const a23 = a[11];
        out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
        out[4] = a01; out[6] = a[9]; out[7] = a[13];
        out[8] = a02; out[9] = a12; out[11] = a[14];
        out[12] = a03; out[13] = a13; out[14] = a23;
      } else {
        out[0] = a[0]; out[1] = a[4]; out[2] = a[8]; out[3] = a[12];
        out[4] = a[1]; out[5] = a[5]; out[6] = a[9]; out[7] = a[13];
        out[8] = a[2]; out[9] = a[6]; out[10] = a[10]; out[11] = a[14];
        out[12] = a[3]; out[13] = a[7]; out[14] = a[11]; out[15] = a[15];
      }
      return out;
    },

    /**
     * 法线矩阵：模型矩阵上 3x3 的逆转置 → 9 元素列主序 mat3。
     * 均匀缩放时法线方向不变；非均匀缩放时逆转置保证法线仍垂直于切平面。
     */
    normalMatrix(out, a) {
      const a00 = a[0], a01 = a[1], a02 = a[2];
      const a10 = a[4], a11 = a[5], a12 = a[6];
      const a20 = a[8], a21 = a[9], a22 = a[10];

      const b00 = a11 * a22 - a12 * a21;
      const b01 = a02 * a21 - a01 * a22;
      const b02 = a01 * a12 - a02 * a11;
      const b10 = a12 * a20 - a10 * a22;
      const b11 = a00 * a22 - a02 * a20;
      const b12 = a02 * a10 - a00 * a12;
      const b20 = a10 * a21 - a11 * a20;
      const b21 = a01 * a20 - a00 * a21;
      const b22 = a00 * a11 - a01 * a10;

      let det = a00 * b00 + a01 * b10 + a02 * b20;
      if (!det) det = 1;
      const id = 1.0 / det;

      // 上 3x3 的逆的转置（列主序输出）
      out[0] = b00 * id; out[1] = b01 * id; out[2] = b02 * id;
      out[3] = b10 * id; out[4] = b11 * id; out[5] = b12 * id;
      out[6] = b20 * id; out[7] = b21 * id; out[8] = b22 * id;
      return out;
    },

    /** 取模型矩阵上 3x3（切线等方向向量变换用） */
    toMat3(out, a) {
      out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
      out[3] = a[4]; out[4] = a[5]; out[5] = a[6];
      out[6] = a[8]; out[7] = a[9]; out[8] = a[10];
      return out;
    },
  };

  /* ===================== 3. 切线计算（选做 E1 法线贴图） ===================== */

  /**
   * 由三角形边与 UV 梯度计算每顶点切线（MikkTSpace 思想），
   * 再做 Gram-Schmidt 正交化；退化三角形（UV 共线 / 球面极点）自动退化处理。
   */
  function computeTangents(positions, normals, uvs, indices) {
    const n = normals.length / 3;
    const tanAcc = new Float32Array(n * 3);

    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];

      const p0x = positions[i0 * 3], p0y = positions[i0 * 3 + 1], p0z = positions[i0 * 3 + 2];
      const e1x = positions[i1 * 3] - p0x, e1y = positions[i1 * 3 + 1] - p0y, e1z = positions[i1 * 3 + 2] - p0z;
      const e2x = positions[i2 * 3] - p0x, e2y = positions[i2 * 3 + 1] - p0y, e2z = positions[i2 * 3 + 2] - p0z;

      const u0 = uvs[i0 * 2], v0 = uvs[i0 * 2 + 1];
      const du1 = uvs[i1 * 2] - u0, dv1 = uvs[i1 * 2 + 1] - v0;
      const du2 = uvs[i2 * 2] - u0, dv2 = uvs[i2 * 2 + 1] - v0;

      const det = du1 * dv2 - du2 * dv1;
      const inv = (Math.abs(det) > 1e-12) ? 1.0 / det : 0.0;

      // T = (dv2*E1 - dv1*E2) / det（uv 平面 → 三维切平面方向）
      const tx = inv * (dv2 * e1x - dv1 * e2x);
      const ty = inv * (dv2 * e1y - dv1 * e2y);
      const tz = inv * (dv2 * e1z - dv1 * e2z);

      tanAcc[i0 * 3] += tx; tanAcc[i0 * 3 + 1] += ty; tanAcc[i0 * 3 + 2] += tz;
      tanAcc[i1 * 3] += tx; tanAcc[i1 * 3 + 1] += ty; tanAcc[i1 * 3 + 2] += tz;
      tanAcc[i2 * 3] += tx; tanAcc[i2 * 3 + 1] += ty; tanAcc[i2 * 3 + 2] += tz;
    }

    const tangents = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
      const tx = tanAcc[i * 3], ty = tanAcc[i * 3 + 1], tz = tanAcc[i * 3 + 2];

      // Gram-Schmidt：去掉切线在法线方向的分量
      const d = tx * nx + ty * ny + tz * nz;
      let ox = tx - d * nx, oy = ty - d * ny, oz = tz - d * nz;
      let len = Math.hypot(ox, oy, oz);
      if (len < 1e-6) {
        // 退化（如球面极点）：取任意与法线垂直的方向
        const ax = Math.abs(nx) < 0.9 ? 1.0 : 0.0;
        const ay = Math.abs(ny) < 0.9 ? 1.0 : 0.0;
        const az = Math.abs(nz) < 0.9 ? 1.0 : 0.0;
        ox = ny * az - nz * ay;
        oy = nz * ax - nx * az;
        oz = nx * ay - ny * ax;
        len = Math.hypot(ox, oy, oz);
      }
      tangents[i * 3] = ox / len;
      tangents[i * 3 + 1] = oy / len;
      tangents[i * 3 + 2] = oz / len;
    }
    return tangents;
  }

  /* ===================== 4. 几何体网格生成 ===================== */

  /** 统一收尾：类型化数组 + 计算切线，返回标准 Mesh 对象 */
  function finalizeMesh(name, positions, normals, uvs, indices) {
    positions = new Float32Array(positions);
    normals = new Float32Array(normals);
    uvs = new Float32Array(uvs);
    indices = new Uint16Array(indices);
    const tangents = computeTangents(positions, normals, uvs, indices);
    return { name, positions, normals, uvs, tangents, indices };
  }

  const SceneGeometry = {
    /**
     * 1) Floor —— 大地面（XZ 平面，法线 +Y，接收阴影）
     *    顶点 4 / 三角形 2；UV 重复 uvRepeat 次配合 REPEAT 平铺棋盘纹理。
     */
    Floor(size = 24, uvRepeat = 12) {
      const h = size / 2;
      const positions = [
        -h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h,
      ];
      const normals = [
        0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
      ];
      const uvs = [
        0, 0, uvRepeat, 0, uvRepeat, uvRepeat, 0, uvRepeat,
      ];
      // 法线 +Y → CCW 从上方看（右手系）
      const indices = [0, 2, 1, 0, 3, 2];
      return finalizeMesh('Floor', positions, normals, uvs, indices);
    },

    /**
     * 2) TexturedCrate —— 木箱/砖块立方体
     *    每面独立 4 顶点（flat shading），24 顶点 / 12 三角形；
     *    每面 UV 0..1 整幅砖墙纹理；配合 E1 法线贴图展示凹凸细节。
     */
    Crate(size = 1.2) {
      const h = size / 2;
      const positions = [], normals = [], uvs = [];
      // 面定义：normal + 切线方向 t（u 轴）；副切线 b = n × t
      const faces = [
        { n: [1, 0, 0], t: [0, 0, -1] },
        { n: [-1, 0, 0], t: [0, 0, 1] },
        { n: [0, 1, 0], t: [1, 0, 0] },
        { n: [0, -1, 0], t: [1, 0, 0] },
        { n: [0, 0, 1], t: [1, 0, 0] },
        { n: [0, 0, -1], t: [-1, 0, 0] },
      ];
      for (const f of faces) {
        const n = f.n, t = f.t;
        const b = Vec3.cross(Vec3.create(), n, t);
        // 四角 c = n*h ± t*h ± b*h（顺序保证 CCW 从面外侧看）
        for (const [st, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          positions.push(
            n[0] * h + t[0] * h * st + b[0] * h * sb,
            n[1] * h + t[1] * h * st + b[1] * h * sb,
            n[2] * h + t[2] * h * st + b[2] * h * sb,
          );
          normals.push(n[0], n[1], n[2]);
        }
        // UV 约定：v=0 对应 canvas 图像顶部（默认 UNPACK_FLIP_Y_WEBGL=false）。
        // 角点顺序 (st,sb)=(-,-)底,(+,-)底,(+,+)顶,(-,+)顶 → 底部 v=1、顶部 v=0
        uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
      }
      const indices = [];
      for (let f = 0; f < 6; f++) {
        const b = f * 4;
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
      return finalizeMesh('TexturedCrate', positions, normals, uvs, indices);
    },

    /**
     * 3) ReflectiveSphere —— 高反射金属球（光滑着色）
     *    顶点 49×33=1617 / 三角形 3072；UV 球参数化，Cubemap 反射采样。
     */
    Sphere(radius = 1.0, lonSegs = 48, latSegs = 32) {
      const positions = [], normals = [], uvs = [], indices = [];
      for (let iy = 0; iy <= latSegs; iy++) {
        const v = iy / latSegs;                 // v=0 顶 → 1 底
        const theta = v * Math.PI;
        const sinT = Math.sin(theta), cosT = Math.cos(theta);
        for (let ix = 0; ix <= lonSegs; ix++) {
          const u = ix / lonSegs;
          const phi = u * Math.PI * 2;
          const sinP = Math.sin(phi), cosP = Math.cos(phi);
          const x = radius * sinT * cosP;
          const y = radius * cosT;
          const z = radius * sinT * sinP;
          positions.push(x, y, z);
          normals.push(sinT * cosP, cosT, sinT * sinP);
          uvs.push(u, v);
        }
      }
      for (let iy = 0; iy < latSegs; iy++) {
        for (let ix = 0; ix < lonSegs; ix++) {
          const a = iy * (lonSegs + 1) + ix;
          const b = a + lonSegs + 1;
          indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
      return finalizeMesh('ReflectiveSphere', positions, normals, uvs, indices);
    },

    /**
     * 4) SculptureTorus —— 中心圆环雕塑（光滑着色，展示三种着色模型对比）
     *    顶点 65×33=2145 / 三角形 4096。
     */
    Torus(majorR = 0.85, minorR = 0.32, segMajor = 64, segMinor = 32) {
      const positions = [], normals = [], uvs = [], indices = [];
      for (let iy = 0; iy <= segMinor; iy++) {
        const v = iy / segMinor;
        const angV = v * Math.PI * 2;
        const cosV = Math.cos(angV), sinV = Math.sin(angV);
        for (let ix = 0; ix <= segMajor; ix++) {
          const u = ix / segMajor;
          const angU = u * Math.PI * 2;
          const cosU = Math.cos(angU), sinU = Math.sin(angU);
          const cx = majorR * cosU, cz = majorR * sinU;
          const x = cx + minorR * cosV * cosU;
          const y = minorR * sinV;
          const z = cz + minorR * cosV * sinU;
          positions.push(x, y, z);
          normals.push(cosV * cosU, sinV, cosV * sinU);
          uvs.push(u * 4, v * 2);   // 重复平铺展示更多纹理细节
        }
      }
      for (let iy = 0; iy < segMinor; iy++) {
        for (let ix = 0; ix < segMajor; ix++) {
          const a = iy * (segMajor + 1) + ix;
          const b = a + segMajor + 1;
          indices.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
      return finalizeMesh('SculptureTorus', positions, normals, uvs, indices);
    },

    /**
     * 5) Pillar —— 八角石柱（flat shading，棱边清晰，投射明显阴影）
     *    顶点 50 / 三角形 32：侧面 8 面 × 4 顶点 + 顶底盖各 9 顶点（扇形）。
     */
    Pillar(radius = 0.35, height = 2.2, sides = 8) {
      const positions = [], normals = [], uvs = [], indices = [];
      const step = Math.PI * 2 / sides;

      // 侧面（每面独立顶点 → flat shading）
      for (let i = 0; i < sides; i++) {
        const a0 = i * step, a1 = (i + 1) * step;
        const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius;
        const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
        const mid = (a0 + a1) / 2;
        const nx = Math.cos(mid), nz = Math.sin(mid);
        const b = positions.length / 3;
        positions.push(
          x0, 0, z0, x1, 0, z1,
          x1, height, z1, x0, height, z0,
        );
        for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);
        // 底部 v=1.5、顶部 v=0（v=0 对应 canvas 图像顶部）
        uvs.push(0, 1.5, 1, 1.5, 1, 0, 0, 0);
        // 绕序：cross(up, tangent) 朝外
        indices.push(b, b + 2, b + 1, b, b + 3, b + 2);
      }

      // 顶盖（法线 +Y，CCW 从上方看）
      {
        const b = positions.length / 3;
        positions.push(0, height, 0);
        normals.push(0, 1, 0);
        uvs.push(0.5, 0.5);
        for (let i = 0; i < sides; i++) {
          const a = i * step;
          positions.push(Math.cos(a) * radius, height, Math.sin(a) * radius);
          normals.push(0, 1, 0);
          uvs.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
        }
        for (let i = 0; i < sides; i++) {
          const i0 = b, i1 = b + 1 + i, i2 = b + 1 + ((i + 1) % sides);
          indices.push(i0, i1, i2);
        }
      }

      // 底盖（法线 -Y，反向绕序）
      {
        const b = positions.length / 3;
        positions.push(0, 0, 0);
        normals.push(0, -1, 0);
        uvs.push(0.5, 0.5);
        for (let i = 0; i < sides; i++) {
          const a = i * step;
          positions.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
          normals.push(0, -1, 0);
          uvs.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
        }
        for (let i = 0; i < sides; i++) {
          const i0 = b, i1 = b + 1 + i, i2 = b + 1 + ((i + 1) % sides);
          indices.push(i0, i2, i1);
        }
      }

      return finalizeMesh('Pillar', positions, normals, uvs, indices);
    },

    /**
     * 6) GlassPyramid —— 半透明水晶方尖碑（E2 Alpha Blend）
     *    顶点 16 / 三角形 6：4 侧面（flat shading）+ 底面。
     */
    Pyramid(base = 1.5, height = 2.0) {
      const positions = [], normals = [], uvs = [], indices = [];
      const h = base / 2;
      const corners = [
        [-h, 0, -h], [h, 0, -h], [h, 0, h], [-h, 0, h],
      ];
      const apex = [0, height, 0];

      // 4 个侧面：外法线 = normalize(cross(apex-c0, c1-c0))（朝外，由构造保证）
      for (let i = 0; i < 4; i++) {
        const c0 = corners[i], c1 = corners[(i + 1) % 4];
        const e1 = Vec3.subtract(Vec3.create(), apex, c0);
        const e2 = Vec3.subtract(Vec3.create(), c1, c0);
        const n = Vec3.normalize(Vec3.create(), Vec3.cross(Vec3.create(), e1, e2));
        const b = positions.length / 3;
        positions.push(
          c0[0], c0[1], c0[2],
          apex[0], apex[1], apex[2],
          c1[0], c1[1], c1[2],
        );
        for (let k = 0; k < 3; k++) normals.push(n[0], n[1], n[2]);
        // 顶点(apex)位于 canvas 顶部 → v=0；底边 v=1
        uvs.push(0, 1, 0.5, 0, 1, 1);
        indices.push(b, b + 1, b + 2);
      }

      // 底面（法线 -Y）
      {
        const b = positions.length / 3;
        for (const c of corners) positions.push(c[0], 0, c[2]);
        for (let k = 0; k < 4; k++) normals.push(0, -1, 0);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }

      return finalizeMesh('GlassPyramid', positions, normals, uvs, indices);
    },

    /** 一键生成全部 6 个物体 */
    all() {
      return {
        floor: SceneGeometry.Floor(),
        crate: SceneGeometry.Crate(),
        sphere: SceneGeometry.Sphere(),
        torus: SceneGeometry.Torus(),
        pillar: SceneGeometry.Pillar(),
        pyramid: SceneGeometry.Pyramid(),
      };
    },
  };

  /* ===================== 5. 程序化纹理生成器 ===================== */

  const ProceduralTextures = {

    /**
     * 棋盘/网格纹理（地面）。512×512、8×8 棋盘 + 网格线 + 每格细微明暗噪声。
     */
    createChecker(size = 512, grid = 8, colorA = '#9a907c', colorB = '#827868', lineColor = '#5e5648', seed = 7) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const ctx = cv.getContext('2d');
      const cell = size / grid;

      ctx.fillStyle = colorA;
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = colorB;
      for (let y = 0; y < grid; y++) {
        for (let x = 0; x < grid; x++) {
          if ((x + y) % 2 === 1) ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }

      // 网格线（瓷砖接缝）
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = Math.max(1, Math.round(size / 256));
      for (let i = 0; i <= grid; i++) {
        const p = Math.round(i * cell) + 0.5;
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
      }

      // 每像素轻微明暗噪声，模拟石材地板质感
      const img = ctx.getImageData(0, 0, size, size);
      const d = img.data;
      const rnd = mulberry32(seed);
      for (let i = 0; i < d.length; i += 4) {
        const f = 0.96 + rnd() * 0.08;
        d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
      }
      ctx.putImageData(img, 0, 0);
      return cv;
    },

    /** 砖墙几何布局参数（颜色纹理与法线贴图共用，保证严格对齐） */
    brickLayout(w, h, rows, cols) {
      const mw = Math.max(2, Math.round(w * 0.012));  // 灰缝宽
      const bw = (w - mw * (cols + 1)) / cols;        // 砖宽
      const bh = (h - mw * (rows + 1)) / rows;        // 砖高
      return { mw, bw, bh, unit: bw + mw, half: (bw + mw) / 2, rows, cols };
    },

    /** 像素 (px,py) 是否落在灰缝上（错缝 + 水平无缝循环；rows 建议取偶数） */
    isMortar(px, py, L, w) {
      const row = Math.floor(py / (L.bh + L.mw));
      const yIn = py - row * (L.bh + L.mw);
      if (yIn < L.mw) return true;                 // 水平灰缝
      let x = px - (row % 2) * L.half;             // 错缝平移（梅花丁/顺丁）
      x = ((x % w) + w) % w;                       // 水平无缝循环
      const col = Math.floor(x / L.unit);
      return (x - col * L.unit) < L.mw;            // 垂直灰缝
    },

    /**
     * 砖墙 2D 纹理 + 与其对齐的 RGB 法线贴图（打包返回）。
     * 512×512、8 行 × 8 列砖，逐砖色差 + 顶亮底暗 + 全局细噪声。
     */
    createBrickSet(w = 512, h = 512, rows = 8, cols = 8,
                   brickBase = [164, 86, 52], mortarBase = [205, 196, 180], seed = 42) {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      const L = this.brickLayout(w, h, rows, cols);
      const rnd = mulberry32(seed);

      // 灰缝底色
      ctx.fillStyle = 'rgb(' + mortarBase[0] + ',' + mortarBase[1] + ',' + mortarBase[2] + ')';
      ctx.fillRect(0, 0, w, h);

      // 逐砖绘制（k 从 -1 到 cols，覆盖错缝跨边界的部分）
      for (let r = 0; r < rows; r++) {
        const y0 = r * (L.bh + L.mw) + L.mw;
        const shift = (r % 2) * L.half;
        for (let k = -1; k <= cols; k++) {
          const x0 = k * L.unit + L.mw + shift;
          const f = 0.85 + rnd() * 0.3;                    // 每块砖独立色差
          const R = Math.min(255, brickBase[0] * f) | 0;
          const G = Math.min(255, brickBase[1] * f) | 0;
          const B = Math.min(255, brickBase[2] * f) | 0;
          ctx.fillStyle = 'rgb(' + R + ',' + G + ',' + B + ')';
          ctx.fillRect(x0, y0, L.bw, L.bh);
          // 顶亮底暗：模拟砖块立体感
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.fillRect(x0, y0, L.bw, Math.max(1, L.bh * 0.12));
          ctx.fillStyle = 'rgba(0,0,0,0.14)';
          ctx.fillRect(x0, y0 + L.bh - Math.max(1, L.bh * 0.10), L.bw, Math.max(1, L.bh * 0.10));
        }
      }

      // 全局细噪声
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const f = 0.97 + rnd() * 0.06;
        d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
      }
      ctx.putImageData(img, 0, 0);
      return { color: cv, layout: L };
    },

    /**
     * 砖墙法线贴图（选做 E1）：
     * 高度场（砖=1，灰缝=0）→ 盒式模糊两轮形成斜面 → Sobel 求梯度 →
     * 法线 = normalize(-gx, -gy, 1) 编码为 RGB（n*0.5+0.5）。
     * 与 createBrickSet 使用同一 brickLayout → 凹凸与砖缝严格对齐。
     */
    createBrickNormalMap(w = 512, h = 512, rows = 8, cols = 8, strength = 1.6) {
      const L = this.brickLayout(w, h, rows, cols);

      // 1) 高度场
      let height = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          height[y * w + x] = this.isMortar(x + 0.5, y + 0.5, L, w) ? 0.0 : 1.0;
        }
      }

      // 2) 盒式模糊（环绕，无缝）两轮 → 灰缝边缘平滑斜面
      height = ProceduralTextures.boxBlurWrap(height, w, h, 2);
      height = ProceduralTextures.boxBlurWrap(height, w, h, 2);

      // 3) Sobel 梯度 → RGB 法线
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        const yU = (y - 1 + h) % h, yD = (y + 1) % h;
        for (let x = 0; x < w; x++) {
          const xL = (x - 1 + w) % w, xR = (x + 1) % w;
          const gx = height[y * w + xL] - height[y * w + xR];
          const gy = height[yU * w + x] - height[yD * w + x];
          // 法线 ∝ (-dH/du, -dH/dv, 1)：gx = H[x-1]-H[x+1] ≈ -2·dH/du → 取 +gx；
          // 砖箱 UV 中 v 与图像 y 方向相反（v=0 在顶部）→ 垂直分量取 -gy。
          const nx = gx * strength, ny = -gy * strength, nz = 1.0;
          const len = Math.hypot(nx, ny, nz) || 1.0;
          const i = (y * w + x) * 4;
          d[i] = Math.round((nx / len * 0.5 + 0.5) * 255);
          d[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
          d[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return cv;
    },

    /** 环绕盒式模糊（可分离：先水平后垂直） */
    boxBlurWrap(src, w, h, radius) {
      const tmp = new Float32Array(w * h);
      const out = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let k = -radius; k <= radius; k++) s += src[y * w + ((x + k + w) % w)];
          tmp[y * w + x] = s / (radius * 2 + 1);
        }
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let s = 0;
          for (let k = -radius; k <= radius; k++) s += tmp[((y + k + h) % h) * w + x];
          out[y * w + x] = s / (radius * 2 + 1);
        }
      }
      return out;
    },

    /**
     * 程序化石材纹理（石柱，附加）：64×64 随机灰度场上采样（画布双线性
     * 平滑）+ 细噪声 → 天然石材质感。
     */
    createStone(size = 512, seed = 2024) {
      const small = document.createElement('canvas');
      small.width = small.height = 64;
      const sctx = small.getContext('2d');
      const simg = sctx.createImageData(64, 64);
      const rnd = mulberry32(seed);
      for (let i = 0; i < simg.data.length; i += 4) {
        const g = 150 + rnd() * 70;
        simg.data[i] = g; simg.data[i + 1] = g; simg.data[i + 2] = g;
        simg.data[i + 3] = 255;
      }
      sctx.putImageData(simg, 0, 0);

      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(small, 0, 0, size, size);

      const img = ctx.getImageData(0, 0, size, size);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const f = 0.98 + rnd() * 0.04;
        d[i] = Math.min(255, d[i] * f);
        d[i + 1] = Math.min(255, d[i + 1] * f);
        d[i + 2] = Math.min(255, d[i + 2] * (f + 0.01));
      }
      ctx.putImageData(img, 0, 0);
      return cv;
    },

    /* ---------- 天空盒（6 面 Cubemap） ---------- */

    makeCanvas(size) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      return cv;
    },

    /** 四面侧脸：渐变天空（天顶深蓝→地平线暖亮）+ 地面 + 地平线透视网格 */
    drawSideFace(ctx, size) {
      const w = size;
      const horizonY = Math.round(size * 0.72);

      // 天空垂直渐变
      const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
      sky.addColorStop(0.0, '#1d4a8f');
      sky.addColorStop(0.55, '#4f86c6');
      sky.addColorStop(0.85, '#a7c8e8');
      sky.addColorStop(1.0, '#f2e2b8');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, horizonY);

      // 地面
      const gnd = ctx.createLinearGradient(0, horizonY, 0, size);
      gnd.addColorStop(0.0, '#8f9c68');
      gnd.addColorStop(1.0, '#4a5536');
      ctx.fillStyle = gnd;
      ctx.fillRect(0, horizonY, w, size - horizonY);

      // 地平线 + 透视网格（灭点在地平线中点）
      const vpx = w / 2;
      const groundH = size - horizonY;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = Math.max(1, size / 256);
      ctx.beginPath(); ctx.moveTo(0, horizonY); ctx.lineTo(w, horizonY); ctx.stroke();
      for (let i = -6; i <= 6; i++) {
        const t = i / 6;
        const bx = vpx + t * w * 0.75;
        ctx.beginPath(); ctx.moveTo(vpx, horizonY); ctx.lineTo(bx, horizonY + groundH); ctx.stroke();
      }
      for (let i = 1; i <= 6; i++) {
        const t = Math.pow(i / 6, 1.8);   // 近疏远密 → 透视深度感
        const y = horizonY + groundH * t;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // 地平线附近柔和暖光
      const glow = ctx.createRadialGradient(vpx, horizonY, 0, vpx, horizonY, w * 0.45);
      glow.addColorStop(0, 'rgba(255,230,170,0.35)');
      glow.addColorStop(1, 'rgba(255,230,170,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, size);
    },

    /** 太阳（绘制在 +Z 正面，中心对称 → 与 Cubemap 面朝向约定无关） */
    drawSun(ctx, size) {
      const horizonY = Math.round(size * 0.72);
      const cx = size / 2, cy = horizonY - size * 0.16;
      const r = size * 0.22;
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      glow.addColorStop(0, 'rgba(255,250,230,1)');
      glow.addColorStop(0.25, 'rgba(255,240,190,0.95)');
      glow.addColorStop(0.6, 'rgba(255,220,150,0.35)');
      glow.addColorStop(1, 'rgba(255,220,150,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    },

    /** 顶面：天顶深蓝渐变 + 星点（径向对称 → 无朝向问题） */
    drawTop(ctx, size, seed = 5) {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.7);
      g.addColorStop(0, '#123a75');
      g.addColorStop(0.6, '#1d4a8f');
      g.addColorStop(1, '#3c6cb5');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const rnd = mulberry32(seed);
      for (let i = 0; i < 110; i++) {
        const x = rnd() * size, y = rnd() * size;
        const r = 0.6 + rnd() * 1.3;
        const a = 0.25 + rnd() * 0.75;
        ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    },

    /** 底面：庭院地面（同心圆 + 放射线 + 中心圆台，径向对称 → 无朝向问题） */
    drawBottom(ctx, size) {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.7);
      g.addColorStop(0, '#576543');
      g.addColorStop(1, '#2e3723');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);

      ctx.strokeStyle = 'rgba(210,225,180,0.16)';
      ctx.lineWidth = Math.max(1, size / 256);
      for (let i = 1; i <= 6; i++) {
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, (size / 2) * (i / 6), 0, Math.PI * 2);
        ctx.stroke();
      }
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(size / 2, size / 2);
        ctx.lineTo(size / 2 + Math.cos(a) * size / 2, size / 2 + Math.sin(a) * size / 2);
        ctx.stroke();
      }

      ctx.fillStyle = '#6b7a4e';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(220,230,190,0.3)';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.14, 0, Math.PI * 2);
      ctx.stroke();
    },

    /**
     * 生成 6 面 Cubemap（512×512/面）：渐变天空 + 太阳 + 地平线网格 + 星点 + 庭院地面。
     * 返回 { px, nx, py, ny, pz, nz }，main.js 按以下顺序上传：
     *   px → TEXTURE_CUBE_MAP_POSITIVE_X, nx → NEGATIVE_X,
     *   py → POSITIVE_Y, ny → NEGATIVE_Y, pz → POSITIVE_Z, nz → NEGATIVE_Z
     */
    createSkybox(size = 512) {
      const faces = { px: null, nx: null, py: null, ny: null, pz: null, nz: null };
      for (const key of ['px', 'nx', 'pz', 'nz']) {
        const cv = this.makeCanvas(size);
        this.drawSideFace(cv.getContext('2d'), size);
        faces[key] = cv;
      }
      this.drawSun(faces.pz.getContext('2d'), size);   // 太阳画在 +Z 正面
      const top = this.makeCanvas(size);
      this.drawTop(top.getContext('2d'), size);
      const bottom = this.makeCanvas(size);
      this.drawBottom(bottom.getContext('2d'), size);
      faces.py = top;
      faces.ny = bottom;
      return faces;
    },
  };

  /* ============================ 导出 ============================ */

  global.Scene = {
    Vec3,
    Mat4,
    computeTangents,
    SceneGeometry,
    ProceduralTextures,
    helpers: { degToRad, clamp, lerp, mulberry32 },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.Scene;   // 兼容 Node 环境做离线校验
  }
})(typeof window !== 'undefined' ? window : this);
