import { Address as EthereumJsAddress } from "ethereumjs-util";
import { isDeepStrictEqual } from "util";
import Blockchain from "../../src/blockchain";
import { GanacheTrie } from "../../src/helpers/trie";

/**
 * Gets all db data from a trie.
 * @param trie
 * @returns
 */
const getDbData = async (trie: GanacheTrie) => {
  const dbData: (string | Buffer)[] = [];
  for await (const data of trie.db._leveldb.createReadStream()) {
    dbData.push(data);
  }
  return dbData;
};

/**
 * Gets the trie, db data, and account data from the provided blockchain
 * and addresses
 * @param blockchain
 * @param fromAddress
 * @param toAddress
 * @returns
 */
const getBlockchainState = async (
  blockchain: Blockchain,
  addresses: EthereumJsAddress[]
) => {
  const trie = blockchain.trie.copy(true);
  const trieDbData = await getDbData(trie);
  const vm = await blockchain.createVmFromStateTrie(
    trie,
    false,
    false,
    blockchain.common
  );
  const addressStates = [];
  for (const address of addresses) {
    addressStates.push(await vm.stateManager.getAccount(address));
  }
  return { root: trie.root, db: trieDbData, addressStates };
};

/**
 * Gets trie and db data from `blockchain` and account data from each address
 * of `addresses` before and after running `testFunction`. Returns whether the
 * data is `deepStrictEqual` or not.
 * @param blockchain
 * @param addresses
 * @param testFunction
 * @returns Boolean indicating whether the states are `deepStrictEqual` or not.
 */
export const statesAreDeepStrictEqual = async (
  blockchain: Blockchain,
  addresses: EthereumJsAddress[],
  testFunction: () => void
) => {
  const before = await getBlockchainState(blockchain, addresses);
  await testFunction();
  const after = await getBlockchainState(blockchain, addresses);
  return isDeepStrictEqual(before, after);
};
