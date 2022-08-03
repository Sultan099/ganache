import Common from "@ethereumjs/common";
import VM from "@ethereumjs/vm";
import { InterpreterStep } from "@ethereumjs/vm/dist/evm/interpreter";
import { DefaultStateManager } from "@ethereumjs/vm/dist/state/index";
import { Address } from "@ganache/ethereum-address";
import { calculateIntrinsicGas } from "@ganache/ethereum-transaction";
import { CallError } from "@ganache/ethereum-utils";
import { BUFFER_EMPTY, Data, hasOwn, keccak, Quantity } from "@ganache/utils";
import {
  makeStepEvent,
  VmAfterTransactionEvent,
  VmBeforeTransactionEvent,
  VmConsoleLogEvent,
  VmStepEvent
} from "../provider-events";
import {
  Address as EthereumJsAddress,
  BN,
  KECCAK256_NULL
} from "ethereumjs-util";
import { GanacheTrie } from "./trie";
import Blockchain from "../blockchain";
import { Block, RuntimeBlock } from "@ganache/ethereum-block";
import { EVMResult } from "@ethereumjs/vm/dist/evm/evm";
import {
  AccessList,
  AccessLists
} from "@ganache/ethereum-transaction/src/access-lists";
import { ERROR, VmError } from "@ethereumjs/vm/dist/exceptions";
import { warmPrecompiles } from "./precompiles";
import { maybeGetLogs } from "@ganache/console.log";
import Emittery from "emittery";

export type SimulationTransaction = {
  /**
   * The address the transaction is sent from.
   */
  from: Address;
  /**
   * The address the transaction is directed to.
   */
  to?: Address;
  /**
   * Integer of the gas provided for the transaction execution. eth_call consumes zero gas, but this parameter may be needed by some executions.
   */
  gas: Quantity;
  /**
   * Integer of the gasPrice used for each paid gas
   */
  gasPrice: Quantity;
  /**
   * Integer of the value sent with this transaction
   */
  value?: Quantity;
  /**
   * Hash of the method signature and encoded parameters. For details see Ethereum Contract ABI in the Solidity documentation
   */
  data?: Data;
  block: RuntimeBlock;
  /**
   * Array of addresses and storage keys.
   */
  accessList?: AccessList;
};

type CallOverride =
  | Partial<{
      code: string;
      nonce: string;
      balance: string;
      state: { [slot: string]: string };
      stateDiff: never;
    }>
  | Partial<{
      code: string;
      nonce: string;
      balance: string;
      state: never;
      stateDiff: { [slot: string]: string };
    }>;

export type CallOverrides = {
  [address: string]: CallOverride;
};

/**
 * Stripped down version of the type from EthereumJs
 */
interface RunCallOpts {
  caller?: EthereumJsAddress;
  data?: Buffer;
  gasPrice?: BN;
  gasLimit?: BN;
  to?: EthereumJsAddress;
  value?: BN;
  block?: any;
}

export default class SimulationHandler extends Emittery<{
  "ganache:vm:tx:step": VmStepEvent;
  "ganache:vm:tx:before": VmBeforeTransactionEvent;
  "ganache:vm:tx:after": VmAfterTransactionEvent;
  "ganache:vm:tx:console.log": VmConsoleLogEvent;
}> {
  #stateTrie: GanacheTrie;
  #vm: VM;
  #stateManager: DefaultStateManager;
  #runCallOpts: RunCallOpts;
  /** The list of addresses to be excluded from access list */
  #accessListExclusions: EthereumJsAddress[] = [];
  /**The list of addresses only to be added in case of present storage slots */
  #addressesOnlyStorage: EthereumJsAddress[] = [];
  #intrinsicGas: bigint;
  #initializationError: ERROR;

  readonly #transactionContext: object;

  constructor() {
    super();
    this.#transactionContext = {};
  }

  /**
   * Sets up the simulation environment, copying the VM and state trie, setting
   * up step events, warming addresses, updating sender account details, and
   * generating parameters to `runCall`. All changes are made on the VM clone.
   * @param simulationBlock The block to simulate when cloning the state trie.
   * @param transaction The transaction that will be simulated.
   * @param overrides Any VM state overrides to apply when running the
   * simulation.
   */
  async initialize(
    blockchain: Blockchain,
    common: Common,
    simulationBlock: Block,
    transaction: SimulationTransaction,
    overrides?: CallOverrides
  ) {
    const caller = this.toLightEJSAddress(transaction.from);

    const stateTrie = blockchain.trie.copy(false);
    stateTrie.setContext(
      simulationBlock.header.stateRoot.toBuffer(),
      null,
      simulationBlock.header.number
    );
    this.#stateTrie = stateTrie;
    const vm = (this.#vm = await blockchain.createVmFromStateTrie(
      stateTrie,
      false, // precompiles have already been initialized in the stateTrie
      common
    ));
    const stateManager = (this.#stateManager =
      vm.stateManager as DefaultStateManager);
    // take a checkpoint so the `runCall` never writes to the trie. We don't
    // commit/revert later because this stateTrie is ephemeral anyway.
    await stateManager.checkpoint();
    const data = transaction.data;
    let gasLimit = transaction.gas.toBigInt();
    const hasToAddress = transaction.to != null;

    const intrinsicGas = (this.#intrinsicGas = calculateIntrinsicGas(
      data,
      hasToAddress,
      common
    ));
    // subtract out the transaction's base fee from the gas limit before
    // simulating the tx, because `runCall` doesn't account for raw gas costs.
    const gasLeft = gasLimit - intrinsicGas;
    const to = this.toLightEJSAddress(transaction.to);

    this.#emitBefore();

    if (gasLeft >= 0n) {
      this.#setupStepEventEmits();

      if (common.isActivatedEIP(2929)) {
        const precompiles = this.#warmDefaults(caller, to);
        this.#accessListExclusions.push(caller);
        if (to) {
          this.#addressesOnlyStorage.push(to);
        }
        this.#accessListExclusions.push(...precompiles);
      }
      // If there are any overrides requested for eth_call, apply
      // them now before running the simulation.
      if (overrides) {
        await this.#applySimulationOverrides(overrides);
      }
      if (common.isActivatedEIP(2930) && transaction.accessList) {
        this.#warmAccessList(transaction.accessList);
      }

      // we need to update the balance and nonce of the sender _before_
      // we run this transaction so that things that rely on these values
      // are correct (like contract creation!).
      const fromAccount = await stateManager.getAccount(caller);
      fromAccount.nonce.iaddn(1);
      const txCost = new BN(
        (gasLimit * transaction.gasPrice.toBigInt()).toString()
      );
      fromAccount.balance.isub(txCost);
      await stateManager.putAccount(caller, fromAccount);

      this.#runCallOpts = {
        caller,
        data: transaction.data && transaction.data.toBuffer(),
        gasPrice: new BN(transaction.gasPrice.toBuffer()),
        gasLimit: new BN(Quantity.toBuffer(gasLeft)),
        to,
        value:
          transaction.value == null
            ? new BN(0)
            : new BN(transaction.value.toBuffer()),
        block: transaction.block as any
      };
    } else {
      this.#initializationError = ERROR.OUT_OF_GAS;
    }
  }

  #setupStepEventEmits = () => {
    this.#vm.on("step", (event: InterpreterStep) => {
      const logs = maybeGetLogs(event);
      if (logs) {
        this.emit("ganache:vm:tx:console.log", {
          context: this.#transactionContext,
          logs
        });
      }
      const ganacheStepEvent = makeStepEvent(this.#transactionContext, event);
      this.emit("ganache:vm:tx:step", ganacheStepEvent);
    });
  };

  #emitBefore = () => {
    this.emit("ganache:vm:tx:before", {
      context: this.#transactionContext
    });
  };

  #emitAfter = () => {
    this.emit("ganache:vm:tx:after", {
      context: this.#transactionContext
    });
  };

  public toLightEJSAddress(address?: Address): EthereumJsAddress {
    if (address) {
      const buf = address.toBuffer();
      return { buf, equals: (a: { buf: Buffer }) => buf.equals(a.buf) } as any;
    } else {
      return null;
    }
  }

  /**
   * Runs `vm.runCall` based off of the options set from running `initialize`.
   * Throws if there is an `exceptionError` on the result.
   * @returns The `EVMResult` from running the transaction.
   */
  public async runCall(): Promise<EVMResult> {
    let callResult: EVMResult;
    if (this.#initializationError) {
      callResult = {
        execResult: {
          runState: { programCounter: 0 },
          exceptionError: new VmError(this.#initializationError),
          returnValue: BUFFER_EMPTY
        }
      } as any;
    } else if (this.#runCallOpts) {
      callResult = await this.#vm.runCall(this.#runCallOpts);
      this.#emitAfter();
    } else {
      throw new Error("Unknown error when simulating transaction.");
    }

    if (callResult.execResult.exceptionError) {
      throw new CallError(callResult);
    } else {
      return callResult;
    }
  }

  /**
   * Iteratively runs the `vm.runCall` function until the touched addresses and
   * storage are the same as the previously generated access list.
   * @param initialAccessList An access list to compare against the generated
   * access list.
   * @returns The final access list generated, plus an estimate of the gas
   * consumed by running the transaction _with_ the generated access list included.
   */
  public async createAccessList(
    initialAccessList: AccessList
  ): Promise<{ accessList: AccessList; gasUsed: string }> {
    // no real reason why this is our max, feel free to change
    const MAX_ITERATIONS = 1000;
    let previousAccessList = initialAccessList || [];
    let iterations = 0;
    do {
      // checkpoint so we can get back to this vm state after every time we
      // run this loop
      await this.#stateManager.checkpoint();
      const stateManager = this.#stateManager;
      const callResult = await this.runCall();
      const accessList = stateManager.generateAccessList(
        this.#accessListExclusions,
        this.#addressesOnlyStorage
      );
      // we're done making vm state changes so revert
      await stateManager.revert();
      // either the access list passed by the user is the same as what was
      // generated by the VM, or the VM generated the same access list twice
      // in a row, so this is our "best" access list.
      if (AccessLists.areAccessListsSame(previousAccessList, accessList)) {
        const { dataFeeEIP2930 } = AccessLists.getAccessListData(accessList);
        const baseFeeBN = new BN(
          Quantity.toBuffer(this.#intrinsicGas + dataFeeEIP2930)
        );
        const gasUsedBN = callResult.gasUsed.add(baseFeeBN);
        const gasUsed = Quantity.toString(gasUsedBN.toBuffer());
        return { accessList, gasUsed };
      } else {
        previousAccessList = accessList;
      }
      iterations++;
    } while (iterations < MAX_ITERATIONS);
  }

  /**
   * Calls the StateManager's `addWarmedAddress` function for the transaction
   * caller, all precompiles, and the to address, if applicable.
   * @param stateManager
   * @param caller
   * @param to
   * @returns An array of precompile addresses
   */
  #warmDefaults(caller: EthereumJsAddress, to?: EthereumJsAddress) {
    const stateManager = this.#stateManager;
    let precompiles: EthereumJsAddress[] = [];
    // handle Berlin hardfork warm storage reads
    precompiles = warmPrecompiles(stateManager);
    stateManager.addWarmedAddress(caller.buf);
    if (to) stateManager.addWarmedAddress(to.buf);

    return precompiles;
  }

  #warmAccessList(accessList: AccessList) {
    const stateManager = this.#stateManager;
    for (const { address, storageKeys } of accessList) {
      const addressBuf = Address.from(address).toBuffer();
      stateManager.addWarmedAddress(addressBuf);
      for (const slot of storageKeys) {
        stateManager.addWarmedStorage(addressBuf, Data.toBuffer(slot, 32));
      }
    }
  }

  async #applySimulationOverrides(overrides: CallOverrides): Promise<void> {
    const stateTrie = this.#stateTrie;
    const stateManager = this.#stateManager;

    for (const address in overrides) {
      if (!hasOwn(overrides, address)) continue;
      const { balance, nonce, code, state, stateDiff } = overrides[address];

      const vmAddr = { buf: Address.from(address).toBuffer() } as any;
      // group together overrides that update the account
      if (nonce != null || balance != null || code != null) {
        const account = await stateManager.getAccount(vmAddr);

        if (nonce != null) {
          account.nonce = {
            toArrayLike: () =>
              // geth treats empty strings as "0x0" nonce for overrides
              nonce === "" ? BUFFER_EMPTY : Quantity.toBuffer(nonce)
          } as any;
        }
        if (balance != null) {
          account.balance = {
            toArrayLike: () =>
              // geth treats empty strings as "0x0" balance for overrides
              balance === "" ? BUFFER_EMPTY : Quantity.toBuffer(balance)
          } as any;
        }
        if (code != null) {
          // geth treats empty strings as "0x" code for overrides
          const codeBuffer = Data.toBuffer(code === "" ? "0x" : code);
          // The ethereumjs-vm StateManager does not allow to set empty code,
          // therefore we will manually set the code hash when "clearing" the contract code
          const codeHash =
            codeBuffer.length > 0 ? keccak(codeBuffer) : KECCAK256_NULL;
          account.codeHash = codeHash;
          await stateTrie.db.put(codeHash, codeBuffer);
        }
        await stateManager.putAccount(vmAddr, account);
      }
      // group together overrides that update storage
      if (state || stateDiff) {
        if (state) {
          // state and stateDiff fields are mutually exclusive
          if (stateDiff) {
            throw new Error("both state and stateDiff overrides specified");
          }
          // it's possible that the user fed an override with a valid address
          // and slot, but not a value we can actually set in the storage. if
          // so, we don't want to set the storage, and we also don't want to
          // clear it out
          let clearedState = false;
          for (const slot in state) {
            if (!hasOwn(state, slot)) continue;
            const value = state[slot];
            this.#validateStorageOverride(slot, value, "State");
            if (!clearedState) {
              // override.state clears all storage and sets just the specified slots
              await stateManager.clearContractStorage(vmAddr);
              clearedState = true;
            }
            const slotBuf = Data.toBuffer(slot, 32);
            const valueBuf = Data.toBuffer(value);

            await stateManager.putContractStorage(vmAddr, slotBuf, valueBuf);
          }
        } else {
          for (const slot in stateDiff) {
            // don't set storage for invalid values
            if (!hasOwn(stateDiff, slot)) continue;
            const value = stateDiff[slot];
            this.#validateStorageOverride(slot, value, "StateDiff");

            const slotBuf = Data.toBuffer(slot, 32);
            const valueBuf = Data.toBuffer(value);

            await stateManager.putContractStorage(vmAddr, slotBuf, valueBuf);
          }
        }
      }
    }
  }

  #validateStorageOverride = (
    slot: string,
    value: string,
    fieldName: string
  ) => {
    // assume Quantity will handle other types, these are just special string cases
    if (typeof slot === "string" && slot !== "" && slot.indexOf("0x") === 0) {
      // assume we're starting with 0x cause Quantity will verify if not
      if (slot.length != 66) {
        throw new Error(
          `${fieldName} override slot must be a 64 character hex string. Received ${
            slot.length - 2
          } character string.`
        );
      }
    }
    if (value === null || value === undefined) {
      throw new Error(
        `${fieldName} override data not valid. Received: ${value}`
      );
    }
    // assume Quantity will handle other types, these are just special string cases
    if (
      typeof value === "string" &&
      value !== "" &&
      value.indexOf("0x") === 0
    ) {
      if (value.length != 66) {
        throw new Error(
          `${fieldName} override data must be a 64 character hex string. Received ${
            value.length - 2
          } character string.`
        );
      }
    }
  };
}
