import { Quantity } from "@ganache/utils";
import { LevelUp } from "levelup";
import { SecureTrie } from "merkle-patricia-tree";
import { CheckpointDB } from "merkle-patricia-tree/dist/checkpointDb";
import Blockchain from "../blockchain";

export class GanacheTrie extends SecureTrie {
  public readonly blockchain: Blockchain;

  constructor(db: LevelUp | null, root: Buffer, blockchain: Blockchain) {
    super(db, root);
    this.blockchain = blockchain;
  }

  setContext(stateRoot: Buffer, address: Buffer, blockNumber: Quantity) {
    this.root = stateRoot;
  }

  /**
   * Returns a copy of the underlying trie with the interface of GanacheTrie.
   * @param includeCheckpoints - If true and during a checkpoint, the copy will contain the checkpointing metadata and will use the same scratch as underlying db.
   */
  _copy(leveldb: LevelUp, includeCheckpoints: boolean) {
    const secureTrie = new GanacheTrie(leveldb, this.root, this.blockchain);
    if (includeCheckpoints && this.isCheckpoint) {
      secureTrie.db.checkpoints = [...this.db.checkpoints];
    }
    return secureTrie;
  }
  /**
   * Returns a copy of the underlying trie with the interface of GanacheTrie.
   * @param includeCheckpoints - If true and during a checkpoint, the copy will contain the checkpointing metadata and will use the same scratch as underlying db.
   */
  copy(includeCheckpoints = true) {
    const db = this.db.copy();
    return this._copy(db._leveldb as LevelUp, includeCheckpoints);
  }

  /**
   * Returns a copy of the underlying trie with the interface of GanacheTrie.
   * @param includeCheckpoints - If true and during a checkpoint, the copy will contain the checkpointing metadata and will use the same scratch as underlying db.
   */
  async deepCopy(includeCheckpoints = true) {
    const db = this.db;
    const dbCopy = new CheckpointDB();
    const stream = db._leveldb.createReadStream({
      keys: true,
      values: true
    });
    for await (const pair of stream) {
      const { key, value } = pair as unknown as { key: Buffer; value: Buffer };
      dbCopy.put(key, value);
    }
    return this._copy(dbCopy._leveldb as LevelUp, includeCheckpoints);
  }
}
