import {
  DoubleSide,
  Intersection,
  Material,
  Mesh,
  Object3D,
  WebGLRenderer,
} from "three";
import {
  FeatureIdUniforms,
  FeatureInfo,
  buildOidToFeatureIdMap,
  getSplitMeshesFromTile,
  getTileMeshesByOid,
  queryFeatureFromIntersection,
} from "./utils";

import { MeshCollector } from "./MeshCollector";
import { TilesRenderer } from "3d-tiles-renderer";

interface TileWithCache {
  cached?: {
    scene: Object3D;
  };
}

export class MaptalksTilerPlugin {
  tiles: TilesRenderer | null = null;
  renderer: WebGLRenderer;
  oids: number[] = [];
  private splitMeshCache: Map<string, Mesh[]> = new Map();
  private maxUniformVectors: number = 1024;
  private featureIdCount: number = 32;
  private collectors: Set<MeshCollector> = new Set();

  constructor(params: { renderer: WebGLRenderer }) {
    this.renderer = params.renderer;
  }

  init(tiles: TilesRenderer) {
    this.tiles = tiles;

    this._updateWebGLLimits();

    tiles.addEventListener("load-model", this._onLoadModelCB);
    tiles.addEventListener("tiles-load-end", this._onTilesLoadEndCB);

    // initialize an already-loaded tiles
    tiles.traverse((tile) => {
      const tileWithCache = tile as TileWithCache;
      if (tileWithCache.cached?.scene) {
        this._onLoadModel(tileWithCache.cached.scene);
      }
      return true;
    }, null);
  }

  /**
   * Load model callback
   * @param scene Scene
   */
  _onLoadModelCB = ({ scene }: { scene: Object3D }) => {
    this._onLoadModel(scene);
  };

  /**
   * Tiles load end callback
   * 当所有瓦片加载完成后通知 collectors 更新 meshes
   */
  _onTilesLoadEndCB = () => {
    this._notifyCollectors();
  };

  /**
   * Load model
   * @param scene Scene
   */
  _onLoadModel(scene: Object3D) {
    this.splitMeshCache.clear();

    buildOidToFeatureIdMap(scene);
    scene.traverse((c) => {
      if ((c as Mesh).material) {
        this._setupMaterial(c as Mesh);
      }
    });
  }

  /**
   * 通知所有 collectors 更新 meshes
   */
  private _notifyCollectors(): void {
    for (const collector of this.collectors) {
      collector._updateMeshes();
    }
  }

  /**
   * 注册 MeshCollector（内部方法）
   */
  _registerCollector(collector: MeshCollector): void {
    this.collectors.add(collector);
  }

  /**
   * 注销 MeshCollector（内部方法）
   */
  _unregisterCollector(collector: MeshCollector): void {
    this.collectors.delete(collector);
  }

  /**
   * Update the WebGL limits
   */
  _updateWebGLLimits() {
    const gl = this.renderer.getContext();
    const maxVectors = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
    this.maxUniformVectors = maxVectors;
  }

  /**
   * Dynamically calculate FEATURE_ID_COUNT
   * Determine the most appropriate array size based on WebGL's MAX_FRAGMENT_UNIFORM_VECTORS limit and current oid array length
   * @returns The calculated FEATURE_ID_COUNT value
   * @throws Error When the required featureIdCount exceeds WebGL limits
   */
  _calculateFeatureIdCount(): number {
    const maxUniformVectors = this.maxUniformVectors;

    const currentOidCount = this.oids.length;

    if (currentOidCount > maxUniformVectors) {
      throw new Error(
        `The number of OIDs to hide (${currentOidCount}) exceeds the WebGL MAX_FRAGMENT_UNIFORM_VECTORS limit (${maxUniformVectors}).`
      );
    }

    const minFeatureIdCount = 32;

    if (currentOidCount <= minFeatureIdCount) {
      return minFeatureIdCount;
    }

    const powerOf2 = Math.ceil(Math.log2(currentOidCount));
    const featureIdCount = Math.pow(2, powerOf2);

    return featureIdCount;
  }

  /**
   * Set up shader modification for hiding specific features
   * This function encapsulates the logic of hiding specific featureIds by modifying the material shader through onBeforeCompile
   * @param material Three.js material object
   */
  _setupMaterial(mesh: Mesh) {
    const material = mesh.material as Material;

    // 检查 material 是否已经被设置过，避免重复设置
    if (material.userData._meshHelperSetup) {
      return;
    }
    material.userData._meshHelperSetup = true;

    material.side = DoubleSide;

    const previousOnBeforeCompile = material.onBeforeCompile;

    // 确保material.defines存在
    if (!material.defines) {
      material.defines = {};
    }

    // 在material上存储当前的featureIdCount，用于检测变化
    material.userData._materialFeatureIdCount = this.featureIdCount;

    Object.defineProperty(material.defines, "FEATURE_ID_COUNT", {
      get: () => {
        // 检测全局featureIdCount是否发生变化
        if (material.userData._materialFeatureIdCount !== this.featureIdCount) {
          // featureIdCount发生变化，更新material上的记录
          material.userData._materialFeatureIdCount = this.featureIdCount;

          // 标记材质需要重新编译
          material.needsUpdate = true;
        }

        return material.userData._materialFeatureIdCount;
      },
      enumerable: true,
      configurable: true,
    });

    material.onBeforeCompile = (shader, renderer) => {
      previousOnBeforeCompile?.call(material, shader, renderer);

      // 检查着色器是否已经被注入过，避免重复注入
      if (shader.vertexShader.includes("varying float vFeatureId;")) {
        return;
      }

      // Add uniform declaration
      shader.uniforms.hiddenFeatureIds = new FeatureIdUniforms(mesh, this);

      // Modify vertex shader
      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        `#include <common>
             attribute float _feature_id_0;
             varying float vFeatureId;`
      );

      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
             vFeatureId = _feature_id_0;`
      );

      // Modify fragment shader
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
             uniform float hiddenFeatureIds[FEATURE_ID_COUNT];
             varying float vFeatureId;
      
             bool shouldHideFeature(float featureId) {
               for(int i = 0; i < FEATURE_ID_COUNT; i++) {
                 if(abs(hiddenFeatureIds[i] - featureId) < 0.001) {
                   return true;
                 }
               }
               return false;
             }`
      );

      // Add discard logic at the beginning of the fragment shader
      shader.fragmentShader = shader.fragmentShader.replace(
        "void main() {",
        `void main() {
           if(shouldHideFeature(vFeatureId)) {
             discard;
           }`
      );
    };
  }

  /**
   * Query feature information from intersection
   * @param hit intersection
   * @returns feature information
   */
  queryFeatureFromIntersection(hit: Intersection): FeatureInfo {
    return queryFeatureFromIntersection(hit);
  }

  /**
   * 内部方法：根据 oid 获取 mesh 数组
   * @param oid oid
   * @returns 对应的 mesh 数组
   */
  _getMeshesByOidInternal(oid: number): Mesh[] {
    const tileMeshes = getTileMeshesByOid(this.tiles!, oid);

    const allSplitMeshes: Mesh[] = [];

    for (const tileMesh of tileMeshes) {
      const cacheKey = `${oid}_${tileMesh.uuid}`;

      let splitMeshes = this.splitMeshCache.get(cacheKey);

      if (!splitMeshes) {
        splitMeshes = getSplitMeshesFromTile(tileMesh, oid);
        this.splitMeshCache.set(cacheKey, splitMeshes);
      }
      allSplitMeshes.push(...splitMeshes);
    }

    return allSplitMeshes;
  }

  /**
   * 根据 oid 获取 MeshCollector
   * MeshCollector 会监听瓦片变化，自动更新 meshes 并触发 mesh-change 事件
   * @param oid oid
   * @returns MeshCollector 实例
   */
  getMeshCollectorByOid(oid: number): MeshCollector {
    return new MeshCollector(oid, this);
  }

  /**
   * Hide the corresponding part of the original mesh according to the OID array
   * @param oids Array of OIDs to hide
   * @returns Number of meshes successfully applied shader
   */
  hideByOids(oids: number[]): void {
    this.oids = oids;
    this.featureIdCount = this._calculateFeatureIdCount();
  }

  /**
   * Restore the display of the corresponding mesh according to the OID array
   * @param oids Array of OIDs to restore
   */
  unhideByOids(oids: number[]): void {
    const oidSet = new Set(oids);
    const newOids = this.oids.filter((existingOid) => !oidSet.has(existingOid));
    this.oids = newOids;
    this.featureIdCount = this._calculateFeatureIdCount();
  }

  /**
   * Restore the original materials of the mesh
   */
  unhide(): void {
    this.oids = [];
    this.featureIdCount = this._calculateFeatureIdCount();
  }

  /**
   * Get the current feature ID count
   * @returns The current featureIdCount value
   */
  getFeatureIdCount(): number {
    return this.featureIdCount;
  }

  dispose() {
    const tiles = this.tiles;

    if (tiles) {
      tiles.removeEventListener("load-model", this._onLoadModelCB);
      tiles.removeEventListener("tiles-load-end", this._onTilesLoadEndCB);
    }

    // 清理所有 collectors
    for (const collector of this.collectors) {
      collector.dispose();
    }
    this.collectors.clear();

    this.splitMeshCache.clear();
  }
}
