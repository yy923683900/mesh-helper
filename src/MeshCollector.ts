import { EventDispatcher, Mesh } from "three";

import type { MaptalksTilerPlugin } from "./MaptalksTilerPlugin";

export interface MeshChangeEvent {
  type: "mesh-change";
  meshes: Mesh[];
}

export type MeshCollectorEventMap = {
  "mesh-change": MeshChangeEvent;
};

/**
 * MeshCollector - 用于监听和收集特定 oid 对应的 mesh
 * 随着瓦片变化，会自动更新 meshes 并触发 mesh-change 事件
 */
export class MeshCollector extends EventDispatcher<MeshCollectorEventMap> {
  private oid: number;
  private plugin: MaptalksTilerPlugin;
  private _meshes: Mesh[] = [];
  private _disposed: boolean = false;

  constructor(oid: number, plugin: MaptalksTilerPlugin) {
    super();
    this.oid = oid;
    this.plugin = plugin;

    // 注册到 plugin 的 collector 列表
    plugin._registerCollector(this);

    this._updateMeshes();
  }

  /**
   * 获取当前的 meshes
   */
  get meshes(): Mesh[] {
    return this._meshes;
  }

  /**
   * 内部方法：更新 meshes 并触发事件
   */
  _updateMeshes(): void {
    if (this._disposed) return;

    const newMeshes = this.plugin._getMeshesByOidInternal(this.oid);

    // 检查 meshes 是否发生变化
    const hasChanged =
      newMeshes.length !== this._meshes.length ||
      newMeshes.some((mesh, i) => mesh !== this._meshes[i]);

    if (hasChanged) {
      this._meshes = newMeshes;
      this.dispatchEvent({ type: "mesh-change", meshes: this._meshes });
    }
  }

  /**
   * 获取当前收集器对应的 oid
   */
  getOid(): number {
    return this.oid;
  }

  /**
   * 销毁收集器，停止监听
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.plugin._unregisterCollector(this);
    this._meshes = [];
  }
}
