import type { TextFileAdapter } from "./SidecarRepository";
import { parseSidecar, serializeSidecar, type SidecarSchemaV1 } from "./SidecarSchema";

export class RecoveryRepository {
  constructor(private readonly files: TextFileAdapter, private readonly folder: string) {}

  private path(id: string): string { return `${this.folder.replace(/\/$/, "")}/${id.replace(/[^\w.-]/g, "_")}.recovery.json`; }

  async save(data: SidecarSchemaV1): Promise<void> { await this.files.write(this.path(data.document.id), serializeSidecar(data)); }
  async load(id: string): Promise<SidecarSchemaV1 | null> {
    const path = this.path(id);
    return await this.files.exists(path) ? parseSidecar(await this.files.read(path)) : null;
  }
  async clear(id: string): Promise<void> {
    const path = this.path(id);
    if (this.files.remove && await this.files.exists(path)) await this.files.remove(path);
  }
}
