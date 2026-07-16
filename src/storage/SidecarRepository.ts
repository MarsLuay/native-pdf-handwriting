import { MigrationManager } from "./MigrationManager";
import { serializeSidecar, type SidecarSchemaV1 } from "./SidecarSchema";

export interface TextFileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  remove?(path: string): Promise<void>;
}

export class SidecarRepository {
  private readonly migration = new MigrationManager();

  constructor(private readonly files: TextFileAdapter, private readonly folder: string) {}

  pathFor(documentId: string): string {
    const safe = documentId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${this.folder.replace(/\/$/, "")}/${safe}.json`;
  }

  async load(documentId: string): Promise<SidecarSchemaV1 | null> {
    const path = this.pathFor(documentId);
    if (!await this.files.exists(path)) return null;
    return this.migration.migrate(await this.files.read(path));
  }

  async save(sidecar: SidecarSchemaV1): Promise<void> {
    const path = this.pathFor(sidecar.document.id);
    const next = serializeSidecar(sidecar);
    if (this.files.rename) {
      const temp = `${path}.tmp`;
      await this.files.write(temp, next);
      try {
        this.migration.migrate(await this.files.read(temp));
      } catch (error) {
        if (this.files.remove && await this.files.exists(temp)) await this.files.remove(temp);
        throw error;
      }
      try {
        await this.files.rename(temp, path);
        return;
      } catch {
        if (this.files.remove && await this.files.exists(temp)) await this.files.remove(temp);
      }
    }

    const previous = await this.files.exists(path) ? await this.files.read(path) : null;
    try {
      await this.files.write(path, next);
      this.migration.migrate(await this.files.read(path));
    } catch (error) {
      if (previous !== null) await this.files.write(path, previous);
      else if (this.files.remove && await this.files.exists(path)) await this.files.remove(path);
      throw error;
    }
  }

  async remove(documentId: string): Promise<void> {
    const path = this.pathFor(documentId);
    if (this.files.remove && await this.files.exists(path)) await this.files.remove(path);
  }
}
