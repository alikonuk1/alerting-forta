import BigNumber from "bignumber.js";

import {
  ethers,
  BlockEvent,
  TransactionEvent,
  Finding,
  FindingType,
  FindingSeverity,
  LogDescription,
} from "forta-agent";

import { ethersProvider } from "./ethers";

import {
  MONITORED_TOKENS,
  TRANSFER_EVENT,
  TransferEventInfo,
  PARTIALLY_MONITORED_TOKENS,
  COMPLEX_TRANSFERS_TEMPLATES,
  TransferText,
  TransferEventMetadata,
  LDO_TOKEN_ADDRESS,
  STETH_TOKEN_ADDRESS,
  WSTETH_TOKEN_ADDRESS,
  AAVE_VAULT_ADDRESS,
  WSTETH_A_VAULT_ADDRESS,
  WSTETH_B_VAULT_ADDRESS,
} from "./constants";

import {
  handleComplexTransfers,
  etherscanLink,
  prepareTransferMetadata,
  applicableAmount,
  handleCurveExchange,
  prepareTransferEventText,
} from "./helpers";

import ERC20_SHORT_TOKEN_ABI from "./abi/ERC20balance.json";
import { ETH_DECIMALS } from "./constants";

export const name = "Huge TX detector";

const poolMinutesWindow = 15;
const poolBlockWindow = Math.round((60 * poolMinutesWindow) / 13);
let lastVaultBalanceBlock = 0;
let lastAaveVaultBalance = 0;
let lastMakerAVaultBalance = 0;
let lastMakerBVaultBalance = 0;

// 15%
const balanceChangeThreshold = 15;

export async function initialize(
  currentBlock: number
): Promise<{ [key: string]: string }> {
  console.log(`[${name}]`);
  [lastAaveVaultBalance, lastMakerAVaultBalance, lastMakerBVaultBalance] =
    await getVaultsBalances(currentBlock);
  lastVaultBalanceBlock = currentBlock;
  return {
    aaveVaultBalance: lastAaveVaultBalance.toFixed(),
    makerAVaultBalance: lastMakerAVaultBalance.toFixed(),
    makerBVaultBalance: lastMakerBVaultBalance.toFixed(),
    poolBlockWindow: poolBlockWindow.toFixed(),
  };
}

export async function handleBlock(blockEvent: BlockEvent) {
  const findings: Finding[] = [];
  await Promise.all([handleVaultBalance(blockEvent, findings)]);
  return findings;
}

async function getVaultsBalances(blockNumber: number) {
  const stETH = new ethers.Contract(
    STETH_TOKEN_ADDRESS,
    ERC20_SHORT_TOKEN_ABI,
    ethersProvider
  );
  const wstETH = new ethers.Contract(
    WSTETH_TOKEN_ADDRESS,
    ERC20_SHORT_TOKEN_ABI,
    ethersProvider
  );

  const aaveVaultBalance = new BigNumber(
    String(
      await stETH.functions.balanceOf(AAVE_VAULT_ADDRESS, {
        blockTag: blockNumber,
      })
    )
  )
    .div(ETH_DECIMALS)
    .toNumber();
  const makerAVaultBalance = new BigNumber(
    String(
      await wstETH.functions.balanceOf(WSTETH_A_VAULT_ADDRESS, {
        blockTag: blockNumber,
      })
    )
  )
    .div(ETH_DECIMALS)
    .toNumber();
  const makerBVaultBalance = new BigNumber(
    String(
      await wstETH.functions.balanceOf(WSTETH_B_VAULT_ADDRESS, {
        blockTag: blockNumber,
      })
    )
  )
    .div(ETH_DECIMALS)
    .toNumber();

  return [aaveVaultBalance, makerAVaultBalance, makerBVaultBalance];
}

function getDiffPercents(before: number, after: number): number {
  return ((after - before) / before) * 100;
}

async function handleVaultBalance(blockEvent: BlockEvent, findings: Finding[]) {
  if (blockEvent.blockNumber % poolBlockWindow == 0) {
    const [aaveVaultBalance, makerAVaultBalance, makerBVaultBalance] =
      await getVaultsBalances(blockEvent.blockNumber);

    const aaveDiff = getDiffPercents(lastAaveVaultBalance, aaveVaultBalance);
    const makerADiff = getDiffPercents(
      lastMakerAVaultBalance,
      makerAVaultBalance
    );
    const makerBDiff = getDiffPercents(
      lastMakerBVaultBalance,
      makerBVaultBalance
    );

    if (Math.abs(aaveDiff) > balanceChangeThreshold) {
      const aaveChangeText = aaveDiff > 0 ? "increased" : "decreased";
      findings.push(
        Finding.fromObject({
          name: "Huge change in AAVE vault balance",
          description:
            "AAVE vault balance has " +
            `${aaveChangeText} by ${Math.abs(aaveDiff).toFixed(2)}% ` +
            `during last ${poolMinutesWindow} min.\n` +
            `Previous balance: ${lastAaveVaultBalance.toFixed(2)} stETH\n` +
            `Current balance: ${aaveVaultBalance.toFixed(2)} stETH\n`,
          alertId: "HUGE-VAULT-BALANCE-CHANGE",
          severity: FindingSeverity.Info,
          type: FindingType.Info,
        })
      );
    }

    if (Math.abs(makerADiff) > balanceChangeThreshold) {
      const makerAChangeText = makerADiff > 0 ? "increased" : "decreased";
      findings.push(
        Finding.fromObject({
          name: "Huge change in Maker wstETH-A vault balance",
          description:
            "Maker wstETH-A vault balance has " +
            `${makerAChangeText} by ${Math.abs(makerADiff).toFixed(2)}% ` +
            `during last ${poolMinutesWindow} min.\n` +
            `Previous balance: ${lastMakerAVaultBalance.toFixed(2)} wstETH\n` +
            `Current balance: ${makerAVaultBalance.toFixed(2)} wstETH\n`,
          alertId: "HUGE-VAULT-BALANCE-CHANGE",
          severity: FindingSeverity.Info,
          type: FindingType.Info,
        })
      );
    }

    if (Math.abs(makerBDiff) > balanceChangeThreshold) {
      const makerBChangeText = makerBDiff > 0 ? "increased" : "decreased";
      findings.push(
        Finding.fromObject({
          name: "Huge change in Maker wstETH-B vault balance",
          description:
            "Maker wstETH-A vault balance has " +
            `${makerBChangeText} by ${Math.abs(makerBDiff).toFixed(2)}% ` +
            `during last ${poolMinutesWindow} min.\n` +
            `Previous balance: ${lastMakerBVaultBalance.toFixed(2)} wstETH\n` +
            `Current balance: ${makerBVaultBalance.toFixed(2)} wstETH\n`,
          alertId: "HUGE-VAULT-BALANCE-CHANGE",
          severity: FindingSeverity.Info,
          type: FindingType.Info,
        })
      );
    }
    lastAaveVaultBalance = aaveVaultBalance;
    lastMakerAVaultBalance = makerAVaultBalance;
    lastMakerBVaultBalance = makerBVaultBalance;
    lastVaultBalanceBlock = blockEvent.blockNumber;
  }
}

export async function handleTransaction(txEvent: TransactionEvent) {
  const findings: Finding[] = [];
  await Promise.all([handleHugeTx(txEvent, findings)]);
  return findings;
}

async function handleHugeTx(txEvent: TransactionEvent, findings: Finding[]) {
  let transfersTexts: TransferText[] = [];
  let transfersMetadata: TransferEventMetadata[] = [];
  const transferEvents = txEvent
    .filterLog(TRANSFER_EVENT)
    .filter(
      (event) =>
        MONITORED_TOKENS.get(event.address.toLowerCase()) ||
        PARTIALLY_MONITORED_TOKENS.get(event.address.toLowerCase())
    );

  let transferInfos = transferEvents.map(
    (event) => new TransferEventInfo(event)
  );
  transferInfos = transferInfos.filter((transfer) =>
    applicableAmount(transfer)
  );

  let texts: TransferText[] = [];
  let metas: TransferEventMetadata[] = [];
  [transferInfos, texts, metas] = handleCurveExchange(transferInfos, txEvent);
  transfersTexts = transfersTexts.concat(texts);
  transfersMetadata = transfersMetadata.concat(metas);

  COMPLEX_TRANSFERS_TEMPLATES.forEach((template) => {
    let texts: TransferText[] = [];
    let metas: TransferEventMetadata[] = [];
    [transferInfos, texts, metas] = handleComplexTransfers(
      transferInfos,
      template,
      txEvent
    );
    transfersTexts = transfersTexts.concat(texts);
    transfersMetadata = transfersMetadata.concat(metas);
  });

  transferInfos.forEach((transfer) => {
    const transferText = prepareTransferEventText(transfer);
    if (transferText) {
      transfersTexts.push(transferText);
      if (transfer.token != LDO_TOKEN_ADDRESS)
        transfersMetadata.push(
          prepareTransferMetadata(transfer, txEvent, transferText.text)
        );
    }
  });
  transfersTexts.sort((a, b) => a.logIndex - b.logIndex);
  if (transfersTexts.length > 0) {
    findings.push(
      Finding.fromObject({
        name: "Huge token(s) transfer of Lido interest in a single TX",
        description:
          transfersTexts.map((tt) => tt.text).join("\n") +
          `\n${etherscanLink(txEvent.hash)}`,
        alertId: "HUGE-TOKEN-TRANSFERS-IN-SINGLE-TX",
        severity: FindingSeverity.Info,
        type: FindingType.Info,
      })
    );
  }
  transfersMetadata.forEach((meta) => {
    const text = meta.comment;
    meta.comment = meta.comment.split("\n")[0].split("*").join("");
    findings.push(
      Finding.fromObject({
        name: "Huge token transfer of Lido interest (tech)",
        description:
          text +
          `\n${etherscanLink(txEvent.hash)}` +
          "\nNOTE: This is tech alert. Do not route it to the alerts channel!",
        alertId: "HUGE-TOKEN-TRANSFERS-TECH",
        severity: FindingSeverity.Info,
        type: FindingType.Info,
        metadata: meta,
      })
    );
  });
}
