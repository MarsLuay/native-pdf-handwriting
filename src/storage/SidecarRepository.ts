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
    const previous = await this.files.exists(path) ? await this.files.read(path) : null;

    // Stage + validate via temp, then commit. Obsidian's adapter.rename throws
    // "Destination file already exists!" when replacing, so overwriting dest uses
    // write (not rename) whenever the sidecar path is already present.
    if (this.files.rename || this.files.remove) {
      const temp = `${path}.tmp`;
      await this.files.write(temp, next);
      try {
        this.migration.migrate(await this.files.read(temp));
        if (previous !== null) {
          await this.files.write(path, next);
          if (this.files.remove) await this.files.remove(temp);
        } else if (this.files.rename) {
          await this.files.rename(temp, path);
        } else {
          await this.files.write(path, next);
          if (this.files.remove) await this.files.remove(temp);
        }
      } catch (error) {
        if (this.files.remove && await this.files.exists(temp)) await this.files.remove(temp);
        if (previous !== null) await this.files.write(path, previous);
        throw error;
      }
      return;
    }

    try {
      await this.files.write(path, next);
      this.migration.migrate(await this.files.read(path));
    } catch (error) {
      if (previous !== null) await this.files.write(path, previous);
      throw error;
    }
  }

  async remove(documentId: string): Promise<void> {
    const path = this.pathFor(documentId);
    if (this.files.remove && await this.files.exists(path)) await this.files.remove(path);
  }
}
