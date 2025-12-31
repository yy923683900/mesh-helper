import type { MaptalksTilerPlugin } from "../MaptalksTilerPlugin";
import { Mesh } from "three";

export class FeatureIdUniforms {
  mesh: Mesh;
  plugin: MaptalksTilerPlugin;

  constructor(mesh: Mesh, plugin: MaptalksTilerPlugin) {
    this.mesh = mesh;
    this.plugin = plugin;
  }

  get value() {
    const idMap = this.mesh.userData.idMap;
    
    // 如果 idMap 不存在，返回全部填充为 -1 的数组
    if (!idMap) {
      return new Array(this.plugin.getFeatureIdCount()).fill(-1);
    }
    
    // 填充剩余位置为-1，避免与featureId为0的mesh冲突
    const result = new Array(this.plugin.getFeatureIdCount()).fill(-1);
    for (let i = 0; i < this.plugin.oids.length; i++) {
      const oid = this.plugin.oids[i];
      const featureId = idMap[oid];
      // 如果找到对应的 featureId，则使用它；否则保持 -1
      result[i] = featureId !== undefined ? featureId : -1;
    }
    
    return result;
  }
}
