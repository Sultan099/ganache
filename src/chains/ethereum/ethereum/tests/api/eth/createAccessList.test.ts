import assert from "assert";
import { EthereumProvider } from "../../../src/provider";
import getProvider from "../../helpers/getProvider";
import compile, { CompileOutput } from "../../helpers/compile";
import { join } from "path";
import { Data, Quantity } from "@ganache/utils";
import { Ethereum } from "../../../src/api-types";
import { AccessList } from "@ganache/ethereum-transaction/src/access-lists";
import { Address } from "@ganache/ethereum-address";

const encodeValue = (val: string) => {
  return Data.toString(val, 32).slice(2);
};

async function deployContract(provider, from, code) {
  await provider.send("eth_subscribe", ["newHeads"]);
  const transactionHash = await provider.send("eth_sendTransaction", [
    {
      from,
      data: code,
      gas: "0xfffff"
    } as any
  ]);
  await provider.once("message");

  const receipt = await provider.send("eth_getTransactionReceipt", [
    transactionHash
  ]);

  return receipt.contractAddress;
}

describe("api", () => {
  describe("eth", () => {
    describe("createAccessList", () => {
      let contract: CompileOutput;
      let provider: EthereumProvider;
      let from, to, addr, encodedTo, encodedAddr: string;
      let contractAddress: string;
      let contractMethods: { [methodName: string]: string };
      let slot, hexSlot: string;

      before("compile", () => {
        contract = compile(join(__dirname, "./contracts/Inspector.sol"), {
          contractName: "Inspector"
        });
      });

      before(async () => {
        provider = await getProvider({});
        [from, to, addr] = await provider.send("eth_accounts");

        contractAddress = await deployContract(provider, from, contract.code);
        contractMethods = contract.contract.evm.methodIdentifiers;
        // make a random number between 0 and f to use as our slot for these tests
        const random = Math.floor(Math.random() * 16).toString(16);
        slot = `000000000000000000000000000000000000000000000000000000000000000${random}`;
        hexSlot = `0x${slot}`;
        encodedTo = encodeValue(to);
        encodedAddr = encodeValue(addr);
      });

      after(async () => {
        provider && (await provider.disconnect());
      });

      it("creates an access list containing all storage slots read by the transaction", async () => {
        // make a transaction to call the contract function that retrieves storage at a slot
        const data = `0x${contractMethods["getStorageAt(uint256)"]}${slot}`;
        const transaction = {
          from,
          to: contractAddress,
          data
        };

        const { accessList } = await provider.send("eth_createAccessList", [
          transaction,
          "latest"
        ]);

        assert.strictEqual(
          accessList.length,
          1,
          `Unexpected size of access list: ${accessList.length}`
        );
        const { storageKeys } = accessList[0];

        assert.strictEqual(
          storageKeys.length,
          1,
          `Unexpected number of storage keys: ${storageKeys.length}`
        );
        const actualSlot = storageKeys[0];

        assert.strictEqual(
          actualSlot,
          hexSlot,
          `Creating access list read from unexpected storage slot: ${actualSlot}. Expected: ${hexSlot}`
        );
      });

      it("creates an access list containing all storage slots written to by the transaction", async () => {
        // make a transaction to call the contract function that sets storage at a slot
        const value = slot; // we'll just set the value equal to the slot, it doesn't matter what we set
        const data = `0x${contractMethods["setStorageAt(uint256,uint256)"]}${slot}${value}`;
        const transaction = {
          from,
          to: contractAddress,
          data
        };

        const { accessList } = await provider.send("eth_createAccessList", [
          transaction,
          "latest"
        ]);

        assert.strictEqual(
          accessList.length,
          1,
          `Unexpected size of access list: ${accessList.length}. Expected: 1`
        );
        const { storageKeys } = accessList[0];

        assert.strictEqual(
          storageKeys.length,
          1,
          `Unexpected number of storage keys: ${storageKeys.length}. Expected: 1`
        );
        const actualSlot = storageKeys[0];

        assert.strictEqual(
          actualSlot,
          hexSlot,
          `Creating access list wrote to unexpected storage slot: ${actualSlot}. Expected: ${hexSlot}`
        );
      });

      it("creates an access list containing all addresses read by the transaction", async () => {
        // make a transaction to call the contract function that reads the balance of an address
        const data = `0x${contractMethods["getBalance(address)"]}${encodedTo}`;
        const transaction = {
          from,
          to: contractAddress,
          data
        };

        const { accessList } = await provider.send("eth_createAccessList", [
          transaction,
          "latest"
        ]);
        assert.strictEqual(
          accessList.length,
          1,
          `Unexpected size of access list: ${accessList.length}. Expected: 1`
        );
        const { address } = accessList[0];

        assert.strictEqual(
          address,
          to,
          `Access list didn't include expected address.`
        );
      });

      it("creates an access list containing all addresses written to by the transaction", async () => {
        // make a transaction to send some moneys, the complicated way
        const data = `0x${contractMethods["send(address)"]}${encodedTo}`;
        const transaction = {
          from,
          to: contractAddress,
          value: "0xf",
          data
        };

        const { accessList } = await provider.send("eth_createAccessList", [
          transaction,
          "latest"
        ]);
        assert.strictEqual(
          accessList.length,
          1,
          `Unexpected size of access list: ${accessList.length}. Expected: 1`
        );
        const { address } = accessList[0];

        assert.strictEqual(
          address,
          to,
          `Access list didn't include address updated by transaction`
        );
      });

      it("uses the specified block to generate the access list", async () => {
        // this contract function does a few things that will allow us to have different
        // results for creating the access list depending on the block:
        //  1. fetch the data at the specified slot
        //  2. store the specified address in the specified slot
        //  3. if our fetched data at the slot is empty, set it to the contract address
        //  4. return the balance of the address that was stored at the slot
        // So, the first time this is called, the data at the slot is empty and we fill it
        // with the passed address (in our case, the `encodedTo` address). The contract
        // address' balance will be returned. Once that first block is mined and we
        // "call" that method again using eth_createAccessList, the `encodedTo` address
        // is stored in the slot from our previous call, so it "accesses" another
        // address, which will cause it to be added to our access list.
        const data = `0x${contractMethods["getStoredBalance(address,uint256)"]}${encodedTo}${slot}`;
        const transaction = {
          from,
          to: contractAddress,
          data
        };
        // get the current latest block number
        const { number } = await provider.send("eth_getBlockByNumber", [
          "latest"
        ]);

        await provider.send("eth_subscribe", ["newHeads"]);
        // we'll actually send this transaction to make updates to the chain
        await provider.send("eth_sendTransaction", [transaction]);
        await provider.once("message");

        // get the accessList for this transaction on the first block
        const { accessList: before } = await provider.send(
          "eth_createAccessList",
          [transaction, number]
        );
        // and on a latest block
        const { accessList: after } = await provider.send(
          "eth_createAccessList",
          [transaction, "latest"]
        );
        // our call to this contract method should only have touched our
        // contract address in the first attempt
        assert.strictEqual(
          before.length,
          1,
          `Unexpected size of access list: ${before.length}. Expected: 1`
        );
        const { address } = before[0];

        assert.strictEqual(
          address,
          contractAddress,
          `Access list didn't include the contract address`
        );
        // calling the contract method a second time (on the latest block)
        // should have touched our contract address and the to address
        assert.strictEqual(
          after.length,
          2,
          `Unexpected size of access list: ${after.length}. Expected: 2`
        );
        const addresses = after.map(entry => {
          return entry.address;
        });
        assert(
          addresses.includes(to),
          `Access list didn't include address read by contract`
        );
        assert(
          addresses.includes(contractAddress),
          `Access list didn't include address read by contract`
        );
      });

      it("calculates the gas that would be used by the transaction if sent with the returned access list", async () => {
        // make any transaction that will be different with/without an accessList
        //const data = `0x${contractMethods["getStorageAt(uint256)"]}${slot}`;
        const data = `0x${contractMethods["getBalance(address)"]}${encodedTo}`;
        const transaction = {
          from,
          to: contractAddress,
          data
        };
        // get the accessList for this transaction on the latest block
        await provider.send("eth_call", [transaction, "latest"]);
        const { accessList, gasUsed } = await provider.send(
          "eth_createAccessList",
          [transaction, "latest"]
        );
        await provider.send("eth_subscribe", ["newHeads"]);
        // snapshot so we can revert later and be sure we're sending the transaction
        // under the same conditions, with the only difference being that we send
        // an access list
        const snapshotId = await provider.send("evm_snapshot");
        const noAccessListHash = await provider.send("eth_sendTransaction", [
          transaction
        ]);
        await provider.once("message");
        const noAccessListReceipt = await provider.send(
          "eth_getTransactionReceipt",
          [noAccessListHash]
        );

        // revert so we can send again
        await provider.send("evm_revert", [snapshotId]);
        const accessListTransaction: Ethereum.Transaction.EIP2930 = {
          ...transaction,
          accessList,
          type: "0x1",
          gasPrice: "0xfffffffffff"
        };
        const accessListHash = await provider.request({
          method: "eth_sendTransaction",
          params: [accessListTransaction]
        });
        await provider.once("message");
        const accessListReceipt = await provider.request({
          method: "eth_getTransactionReceipt",
          params: [accessListHash]
        });

        const { gasUsed: noAccessListGasUsed } = noAccessListReceipt;

        const { gasUsed: accessListGasUsed } = accessListReceipt;
        assert.strictEqual(
          gasUsed,
          accessListGasUsed,
          `Sending a transaction with an access list didn't use the amount of gas returned by eth_createAccessList`
        );
        assert.notStrictEqual(
          noAccessListGasUsed,
          accessListGasUsed,
          `Transaction used same amount of gas with and without the access list`
        );
      });

      it("returns empty accessList for transactions that only access exempt addresses", async () => {
        // make a transaction to send some moneys
        const transaction = {
          from,
          to,
          value: "0xf"
        };

        const { accessList, gasUsed } = await provider.send(
          "eth_createAccessList",
          [transaction, "latest"]
        );
        assert.strictEqual(
          accessList.length,
          0,
          `Unexpected size of access list: ${accessList.length}. Expected: 0`
        );
        assert.strictEqual(gasUsed, "0x5208");
      });

      it("ignores a given access list if a better one is generated", async () => {
        // make some transaction that will generate an access list,
        // and pass it some nonsense access list to start with
        const data = `0x${contractMethods["getStorageAt(uint256)"]}${slot}`;
        const initialAccessList: AccessList = [
          { address: addr, storageKeys: [] }
        ];
        const transaction = {
          from,
          to: contractAddress,
          data,
          accessList: initialAccessList
        };

        const { accessList } = await provider.send("eth_createAccessList", [
          transaction,
          "latest"
        ]);

        // the generated access list is not the same as the initial nonsense one
        assert.notDeepEqual(accessList, initialAccessList);
      });

      it("uses a generated access list to generate another, confirming that the best one is returned", async () => {
        // make a transaction that will generate different access lists based off of the
        // access list provided.
        const data = `0x${contractMethods["multiAccessList(address)"]}${encodedTo}`;
        const transaction = {
          from,
          to: contractAddress,
          data
        };

        const { accessList } = await provider.send("eth_createAccessList", [
          transaction,
          "latest"
        ]);

        assert.strictEqual(
          accessList.length,
          10,
          `Unexpected size of access list: ${accessList.length}. Expected: 1`
        );
        accessList.forEach((entry, i) => {
          const addressBn = Quantity.toBigInt(to);
          const idxBn = Quantity.toBigInt(i);
          const sumBn = addressBn + idxBn;
          const address = Address.from(Quantity.toBuffer(sumBn)).toString();
          assert.strictEqual(
            entry.address,
            address,
            `Access list included incorrect address. Expected: ${address}. Actual: ${entry.address}.`
          );
        });
      });

      it("does not create a transaction on the chain", async () => {
        // any old transaction will do
        const transaction = { from, to };
        const beforeCall = await provider.send("eth_getBlockByNumber", [
          "latest"
        ]);
        await provider.send("eth_createAccessList", [transaction, "latest"]);
        const afterCall = await provider.send("eth_getBlockByNumber", [
          "latest"
        ]);
        assert.strictEqual(beforeCall.number, afterCall.number);
      });

      it("returns and empty access list if EIP-2930 isn't activated", async () => {
        // make a transaction that would generate and access list if eip was activated
        const data = `0x${contractMethods["getStorageAt(uint256)"]}${slot}`;
        const transaction = {
          from,
          to: contractAddress,
          data
        };

        // before EIP-2930 (berlin hardfork)
        const customProvider = await getProvider({
          chain: { hardfork: "byzantium" }
        });

        const { accessList } = await customProvider.send(
          "eth_createAccessList",
          [transaction, "latest"]
        );
        assert.strictEqual(
          accessList.length,
          0,
          `Access list has content before EIP-2930 is activated.`
        );
        await customProvider.disconnect();
      });

      describe.only("invalid access lists", () => {
        const validAddress = "0x0000000000000000000000000000000000000000";
        const validSlot =
          "0x000000000000000000000000000000000000000000000000000000000000000";
        const getInvalidValues = () => {
          const accessListBadBois = ["0x", 123, true, {}].map(badBoi => {
            return {
              accessList: badBoi,
              error: "access list must be an array"
            };
          });
          const badBoiValues = [
            123,
            true,
            {},
            [],
            null,
            "0x",
            validAddress.slice(2),
            validSlot.slice(2)
          ];
          const addressBadBois = badBoiValues.map(badBoi => {
            return {
              accessList: [{ address: badBoi, storageKeys: [] }],
              error: `access list item's address property must be a valid 20 byte string prefixed with "0x"`
            };
          });

          const storageKeyBadBois = ["0x", 123, true, null, {}].map(badBoi => {
            return {
              accessList: [{ address: validAddress, storageKeys: badBoi }],
              error: `access list item's storageKeys property must be an array of storage keys`
            };
          });

          const storageKeyValueBadBois = badBoiValues.map(badBoi => {
            return {
              accessList: [{ address: validAddress, storageKeys: [badBoi] }],
              error: `each entry of access list item's storageKeys property must be a valid 32 byte string prefixed with "0x"`
            };
          });

          return [
            ...accessListBadBois,
            {
              accessList: [{}],
              error: "access list item must have an address property"
            },
            {
              accessList: [{ address: "" }],
              error: "access list item must have a storageKeys property"
            },
            {
              accessList: [
                {
                  address: "0x000000000000000000000000000000000000000g",
                  storageKeys: []
                }
              ],
              error: `Cannot wrap string value "0x000000000000000000000000000000000000000g" as a json-rpc type; the input value contains an invalid hex character.`
            },
            {
              accessList: [
                {
                  address: validAddress,
                  storageKeys: [
                    "0x000000000000000000000000000000000000000000000000000000000000000g"
                  ]
                }
              ],
              error: `Cannot wrap string value "0x00000000000000000000000000000000000000000000000000000000000000g" as a json-rpc type; the input value contains an invalid hex character.`
            },
            ...addressBadBois,
            ...storageKeyValueBadBois,
            ...storageKeyBadBois
          ];
        };

        const invalids = getInvalidValues();
        for (const { accessList, error } of invalids) {
          it(`validates that ${error} for invalid list ${JSON.stringify(
            accessList
          )}`, async () => {
            // any old transaction will do
            const transaction = { from, to, accessList };
            // @ts-ignore (cause we're using invalid stuff)
            const prom = provider.send("eth_createAccessList", [
              transaction,
              "latest"
            ]);
            try {
              await prom;
            } catch (e: any) {
              if (e.message !== error) {
                console.log(e.message);
              }
            }
            await assert.rejects(
              prom,
              new Error(error),
              `Invalid access list didn't throw with expected error. Expected error: ${error}`
            );
          });
        }
      });
    });
  });
});
