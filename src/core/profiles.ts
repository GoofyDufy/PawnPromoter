/**
 * Player profiles — port of profiles.py: each player gets their OWN database
 * file, so two people sharing the app never mix games, analysis, puzzles,
 * repertoires, stats or settings.
 *
 * A small registry lists the profiles and which one was used last. On the
 * desktop it's profiles.json next to the databases; in the browser it lives in
 * browser storage next to the OPFS database files. Storage is injected so the
 * rules here stay the same everywhere.
 */

export const LEGACY_DB = 'chessprep.db';

export interface Registry {
  current: string;
  profiles: { [name: string]: string };   // name -> database file name (insertion-ordered)
}

export interface ProfileStorage {
  /** The saved registry, or null if there is none (or it's unreadable). */
  load(): Registry | null;
  save(data: Registry): void;
  /** Whether a database file of this name already exists. */
  dbExists(filename: string): boolean;
  /** The chess.com username stored in the original database, if any. */
  legacyUsername(): string;
}

export class Profiles {
  constructor(private readonly storage: ProfileStorage) {}

  private load(): Registry {
    const data = this.storage.load();
    if (data && Object.keys(data.profiles ?? {}).length) return data;
    // first run: the existing database (if any) becomes the first profile
    const name = this.storage.legacyUsername() || 'Player 1';
    const fresh: Registry = { current: name, profiles: { [name]: LEGACY_DB } };
    this.storage.save(fresh);
    return fresh;
  }

  list(): string[] {
    return Object.keys(this.load().profiles);
  }

  current(): string {
    const data = this.load();
    return data.current in data.profiles ? data.current : Object.keys(data.profiles)[0];
  }

  /** Database file name for a profile (desktop: db_path). */
  dbFile(name: string): string {
    return this.load().profiles[name];
  }

  setCurrent(name: string): void {
    const data = this.load();
    if (name in data.profiles) {
      data.current = name;
      this.storage.save(data);
    }
  }

  /** Creates a profile (with its own new database file) and returns its name.
   *  Throws for an empty or duplicate name. */
  add(rawName: string): string {
    const name = rawName.trim();
    const data = this.load();
    if (!name) throw new Error('Enter a name.');
    if (Object.keys(data.profiles).some((p) => p.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A player called '${name}' already exists.`);
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'player';
    const used = new Set(Object.values(data.profiles));
    let filename = `chessprep_${slug}.db`;
    let n = 2;
    while (used.has(filename) || this.storage.dbExists(filename)) {
      filename = `chessprep_${slug}_${n}.db`;
      n += 1;
    }
    data.profiles[name] = filename;
    this.storage.save(data);
    return name;
  }
}
