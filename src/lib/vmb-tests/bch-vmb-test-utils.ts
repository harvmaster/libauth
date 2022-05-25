/**
 * This script generates all bch_vmb_tests, run it with: `yarn gen:tests`.
 */
import { encodeBech32, regroupBits } from '../address/address.js';
import { createCompilerBCH } from '../compiler/compiler-bch/compiler-bch.js';
import { authenticationTemplateToCompilerConfiguration } from '../compiler/compiler-utils.js';
import { sha256 } from '../crypto/crypto.js';
import { binToHex, flattenBinArray } from '../format/format.js';
import type {
  AuthenticationTemplate,
  AuthenticationTemplateScenario,
} from '../lib';
import {
  encodeTransaction,
  encodeTransactionOutputs,
} from '../message/message.js';

import { slot1Scenario } from './bch-vmb-test-mixins.js';

/**
 * These are the VM versions for which tests are currently generated.
 *
 * A new 4-digit year should be added to prepare for each annual upgrade.
 * Libauth can also support testing of draft proposals by specifying a short
 * identifier for each independent proposal.
 */
const vmVersionsBCH = [
  '2021',
  '2022',
  'chip_cashtokens',
  'chip_limits',
  'chip_loops',
  'chip_minimalbool',
  'chip_p2sh32',
  'chip_strict_checkmultisig',
  'chip_zce',
] as const;
/**
 * These are the VM "modes" for which tests can be generated.
 */
const vmModes = ['nop2sh', 'p2sh20', 'p2sh32'] as const;

type TestSetType = 'invalid' | 'nonstandard' | 'standard';
type TestSetOverrideType = TestSetType | 'ignore';
type VmVersionBCH = typeof vmVersionsBCH[number];
type VmMode = typeof vmModes[number];
type TestSetOverrideLabelBCH =
  | `${TestSetOverrideType}`
  | `${VmMode}_${TestSetOverrideType}`
  | `${VmVersionBCH}_${TestSetOverrideType}`
  | `${VmVersionBCH}_${VmMode}_${TestSetOverrideType}`;

export type TestSetIdBCH = `${VmVersionBCH}_${TestSetType}`;

export type VmbTestMasterBCH = [
  shortId: string,
  testDescription: string,
  unlockingScriptAsm: string,
  redeemOrLockingScriptAsm: string,
  testTransactionHex: string,
  sourceOutputsHex: string,
  testSets: TestSetIdBCH[],
  /**
   * This isn't required for testing (implementations should always validate the
   * full test transaction), but it can allow downstream applications to
   * identify which source output/transaction input index is the focus of each
   * test. This is sometimes useful for debugging or for VM documentation
   * projects that extract usage examples from vmb tests.
   *
   * This field is left undefined for `inputIndex`s of `0` (the default).
   */
  inputIndex?: number
];

export type VmbTest = [
  shortId: string,
  testDescription: string,
  unlockingScriptAsm: string,
  redeemOrLockingScriptAsm: string,
  testTransactionHex: string,
  sourceOutputsHex: string,
  inputIndex?: number
];

/**
 * Not used currently, but these are the defaults that inform
 * {@link supportedTestSetOverridesBCH}.
 */
export const vmbTestDefinitionDefaultBehaviorBCH: TestSetOverrideLabelBCH[] = [
  'nop2sh_nonstandard',
  'p2sh20_standard',
  'p2sh32_ignore',
];

/* eslint-disable @typescript-eslint/naming-convention */
/**
 * The list of test set overrides currently supported. Eventually this should be
 * `TestSetOverride`.
 *
 * For now, this implementation simplifies VMB test generation – we just
 * `join()` the provided overrides and look up resulting modes/test sets here.
 */
type TestSetOverrideListBCH =
  | ['2021_invalid', '2022_nonstandard', 'p2sh_ignore']
  | ['2021_invalid', '2022_nonstandard']
  | ['2021_invalid', 'nonP2sh_invalid']
  | ['2021_invalid', 'nonP2sh20_invalid']
  | ['2021_invalid', 'p2sh_ignore']
  | ['2021_invalid', 'p2sh_invalid']
  | ['2021_invalid']
  | ['invalid', '2022_nonP2sh_nonstandard']
  | ['invalid', '2022_p2sh_standard']
  | ['invalid', 'nonP2sh_nonstandard']
  | ['invalid', 'p2sh_ignore']
  | ['invalid']
  | ['nonstandard', 'p2sh_invalid']
  | ['nonstandard']
  | [];

type TestPlan = {
  mode: 'nonP2SH' | 'P2SH20' | 'P2SH32';
  sets: TestSetIdBCH[];
}[];
/**
 * Given one of these values and the {@link vmbTestDefinitionDefaultBehavior},
 * return these test plans.
 */
export const supportedTestSetOverridesBCH: {
  [joinedList: string]: TestPlan;
} = {
  '': [
    { mode: 'nonP2SH', sets: ['2021_nonstandard', '2022_nonstandard'] },
    { mode: 'P2SH20', sets: ['2021_standard', '2022_standard'] },
  ],
  '2021_invalid': [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_nonstandard'] },
    { mode: 'P2SH20', sets: ['2021_invalid', '2022_standard'] },
  ],
  '2021_invalid,2022_nonstandard': [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_nonstandard'] },
    { mode: 'P2SH20', sets: ['2021_invalid', '2022_nonstandard'] },
  ],
  '2021_invalid,2022_nonstandard,p2sh_ignore': [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_nonstandard'] },
  ],
  '2021_invalid,nonP2sh20_invalid': [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_invalid'] },
    { mode: 'P2SH20', sets: ['2021_invalid', '2022_standard'] },
  ],
  '2021_invalid,nonP2sh_invalid': [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_invalid'] },
    { mode: 'P2SH20', sets: ['2021_invalid', '2022_standard'] },
  ],
  '2021_invalid,p2sh_ignore': [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_nonstandard'] },
  ],
  '2021_invalid,p2sh_invalid': [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_nonstandard'] },
    { mode: 'P2SH20', sets: ['2021_invalid', '2022_invalid'] },
  ],
  invalid: [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_invalid'] },
    { mode: 'P2SH20', sets: ['2021_invalid', '2022_invalid'] },
  ],
  'invalid,2022_nonP2sh_nonstandard': [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_nonstandard'] },
    { mode: 'P2SH20', sets: ['2021_invalid', '2022_invalid'] },
  ],
  'invalid,2022_p2sh_standard': [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_invalid'] },
    { mode: 'P2SH20', sets: ['2021_invalid', '2022_standard'] },
  ],
  'invalid,nonP2sh_nonstandard': [
    { mode: 'nonP2SH', sets: ['2021_nonstandard', '2022_nonstandard'] },
    { mode: 'P2SH20', sets: ['2021_invalid', '2022_invalid'] },
  ],
  'invalid,p2sh_ignore': [
    { mode: 'nonP2SH', sets: ['2021_invalid', '2022_invalid'] },
  ],
  nonstandard: [
    { mode: 'nonP2SH', sets: ['2021_nonstandard', '2022_nonstandard'] },
    { mode: 'P2SH20', sets: ['2021_nonstandard', '2022_nonstandard'] },
  ],
  'nonstandard,p2sh_invalid': [
    { mode: 'nonP2SH', sets: ['2021_nonstandard', '2022_nonstandard'] },
    { mode: 'P2SH20', sets: ['2021_invalid', '2022_invalid'] },
  ],
};
/* eslint-enable @typescript-eslint/naming-convention */

export type VmbTestDefinition = [
  /**
   * This script (defined using CashAssembly) is compiled to `unlockingBytecode`
   * in the test transaction(s) produced by this test definition.
   */
  unlockingScript: string,
  /**
   * This script (defined using CashAssembly) is compiled to the
   * `redeemBytecode` and/or `lockingBytecode` to be satisfied by
   * `unlockingScript`.
   *
   * By default, each test definitions generates two tests, one test uses this
   * value as a simple `lockingBytecode`, the other test encodes this value as
   * the `redeemBytecode` of a P2SH20 UTXO (properly appending it to
   * `unlockingBytecode` in the test transaction).
   *
   * For `standard` test definitions, the P2SH evaluation is tested in standard
   * mode and the non-P2SH evaluation is tested in non-standard mode (marked as
   * only a `valid` test). For `valid` test definitions, both tests are marked
   * as `valid`.
   */
  redeemOrLockingScript: string,
  testDescription: string,
  testSetOverrideLabels?: TestSetOverrideListBCH,
  /**
   * A scenario that extends the default scenario for use with this test.
   */
  scenario?: AuthenticationTemplateScenario,
  /**
   * An additional mapping of scripts to make available during scenario
   * generation.
   */
  additionalScripts?: AuthenticationTemplate['scripts']
];
export type VmbTestDefinitionGroup = [
  groupDescription: string,
  tests: VmbTestDefinition[]
];

/**
 * Short IDs use bech32 encoding, so birthday collisions will happen
 * approximately every `Math.sqrt(2 * (32 ** defaultShortIdLength))` tests.
 */
const defaultShortIdLength = 5;

const planTestsBCH = (
  labels?: string[]
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
) => supportedTestSetOverridesBCH[(labels ?? []).join(',')]!;

/**
 * Given a VMB test definition, generate a full VMB test vector. Note, this
 * method throws immediately on the first test vector generation failure.
 */
export const vmbTestDefinitionToVmbTests = (
  testDefinition: VmbTestDefinition,
  groupName = '',
  shortIdLength = defaultShortIdLength
): VmbTestMasterBCH[] => {
  const [
    unlockingScript,
    redeemOrLockingScript,
    testDescription,
    testSetOverrideLabels,
    scenarioOverride,
    additionalScripts,
  ] = testDefinition;
  const scenarioId = 'test';

  const testGenerationPlan = planTestsBCH(testSetOverrideLabels);

  const scenarioDefinition = { extends: 'vmb_default', ...scenarioOverride };

  const configuration = authenticationTemplateToCompilerConfiguration({
    entities: { tester: { variables: { key1: { type: 'HdKey' } } } },
    scenarios: {
      [scenarioId]: scenarioDefinition,
      // eslint-disable-next-line @typescript-eslint/naming-convention, camelcase
      vmb_default: slot1Scenario,
    },
    scripts: {
      ...additionalScripts,
      lockEmptyP2sh20: { lockingType: 'p2sh20', script: '' },
      lockP2pkh: {
        lockingType: 'standard',
        script:
          'OP_DUP OP_HASH160 <$(<key1.public_key> OP_HASH160)> OP_EQUALVERIFY OP_CHECKSIG',
      },
      lockP2sh20: { lockingType: 'p2sh20', script: redeemOrLockingScript },
      lockStandard: { lockingType: 'standard', script: redeemOrLockingScript },
      unlockEmptyP2sh20: { script: '<1>', unlocks: 'lockEmptyP2sh20' },
      unlockP2pkh: {
        /**
         * Uses `corresponding_output_single_input` to reuse the same signature
         * as much as possible (making VMB test files more compressible).
         */
        script:
          '<key1.schnorr_signature.corresponding_output_single_input> <key1.public_key>',
        unlocks: 'lockP2pkh',
      },
      unlockP2sh20: { script: unlockingScript, unlocks: 'lockP2sh20' },
      unlockStandard: { script: unlockingScript, unlocks: 'lockStandard' },
      vmbTestNullData: {
        lockingType: 'standard',
        script: 'OP_RETURN <"vmb_test">',
      },
    },
    supported: ['BCH_2022_05'],
    version: 0,
  });
  const compiler = createCompilerBCH(configuration);

  const tests = testGenerationPlan.map((planItem) => {
    const description = `${groupName}: ${testDescription} (${planItem.mode})`;
    const result = compiler.generateScenario({
      debug: true,
      scenarioId,
      unlockingScriptId: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        P2SH20: 'unlockP2sh20',
        // eslint-disable-next-line @typescript-eslint/naming-convention
        P2SH32: 'unlockP2sh32',
        nonP2SH: 'unlockStandard',
      }[planItem.mode],
    });
    if (typeof result === 'string') {
      // eslint-disable-next-line functional/no-throw-statement
      throw new Error(`Error while generating "${description}" - ${result}`);
    }
    if (typeof result.scenario === 'string') {
      // eslint-disable-next-line functional/no-throw-statement
      throw new Error(
        `Error while generating "${description}" - ${result.scenario}`
      );
    }
    const encodedTx = encodeTransaction(result.scenario.program.transaction);
    const encodedSourceOutputs = encodeTransactionOutputs(
      result.scenario.program.sourceOutputs
    );
    const shortId = encodeBech32(
      regroupBits({
        bin: sha256.hash(flattenBinArray([encodedTx, encodedSourceOutputs])),
        resultWordLength: 5,
        sourceWordLength: 8,
      }) as number[]
    ).slice(0, shortIdLength);

    const testCase = [
      shortId,
      description,
      unlockingScript,
      redeemOrLockingScript,
      binToHex(encodedTx),
      binToHex(encodedSourceOutputs),
      planItem.sets,
    ];

    return (
      result.scenario.program.inputIndex === 0
        ? testCase
        : [...testCase, result.scenario.program.inputIndex]
    ) as VmbTestMasterBCH;
  });

  return tests;
};

export const vmbTestGroupToVmbTests = (testGroup: VmbTestDefinitionGroup) =>
  testGroup[1].map((testDefinition) =>
    vmbTestDefinitionToVmbTests(testDefinition, testGroup[0])
  );

/**
 * Partition a master test list (produced by {@link vmbTestGroupToVmbTests} or
 * {@link vmbTestDefinitionToVmbTests}) into sets. E.g.:
 * ```ts
 * const definitions: VmbTestDefinitionGroup[] = [...]
 * const master = [
 *   vmbTestDefinitionToVmbTests(...),
 *   vmbTestDefinitionToVmbTests(...),
 * ];
 * const partitioned = vmbTestPartitionMasterTestList(master);
 * ```
 * Or:
 * ```ts
 * const definitions: VmbTestDefinitionGroup[] = [...]
 * const master = definitions.map(vmbTestGroupToVmbTests).flat(2);
 * const partitioned = vmbTestPartitionMasterTestList(master);
 * ```
 * Tests are aggregated by set into a map of test sets (e.g. to export to
 * separate files).
 */
export const vmbTestPartitionMasterTestList = (
  masterTestList: VmbTestMasterBCH[]
) =>
  masterTestList.reduce<{
    [key in TestSetIdBCH]?: VmbTest[];
  }>((accumulatedTestSets, testCase) => {
    const [
      shortId,
      testDescription,
      unlockingScriptAsm,
      redeemOrLockingScriptAsm,
      testTransactionHex,
      sourceOutputsHex,
      testSets,
      inputIndex,
    ] = testCase;

    const withoutSets = [
      shortId,
      testDescription,
      unlockingScriptAsm,
      redeemOrLockingScriptAsm,
      testTransactionHex,
      sourceOutputsHex,
      ...(inputIndex === undefined ? [] : [inputIndex]),
    ] as VmbTest;

    // eslint-disable-next-line functional/no-return-void, functional/no-expression-statement
    testSets.forEach((testSet) => {
      // eslint-disable-next-line functional/immutable-data, functional/no-expression-statement
      accumulatedTestSets[testSet] = [
        ...(accumulatedTestSets[testSet] ?? []),
        withoutSets,
      ];
    });
    return accumulatedTestSets;
  }, {});