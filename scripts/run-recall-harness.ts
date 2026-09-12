#!/usr/bin/env node
/**
 * CLI Runner for redMem RAG Recall Harness (Card 6aa1d9c408971669b4a25d1f).
 *
 * Can be run nightly or on-demand:
 *   npx tsx scripts/run-recall-harness.ts [--gate-deploy]
 */
import { RecallHarnessRunner } from '../src/lib/memory/recall-harness';

async function main() {
  const gateDeploy = process.argv.includes('--gate-deploy');
  console.log('====================================================');
  console.log('  redMem RAG Recall Harness (Nightly Evaluation)    ');
  console.log('====================================================');
  console.log(`Deploy Gating: ${gateDeploy ? 'ENABLED (gating)' : 'DISABLED (tracking only)'}`);
  console.log('Seeded Memories: 20 facts across 7 domains');
  console.log('Scripted Questions: 30 cases (15 pos, 10 neg, 5 canaries)\n');

  const runner = new RecallHarnessRunner({
    gateDeploy,
    fileCardOnFailure: true,
  });

  const report = await runner.run();

  console.log('----------------------------------------------------');
  console.log(`Run ID:                     ${report.runId}`);
  console.log(`Status:                     ${report.passed ? 'PASSED' : 'FAILED'}`);
  console.log(`Positive Recall:            ${report.positiveRecallRate}% (${report.positivePassed}/${report.positiveCount}) [Target >=90%]`);
  console.log(`Canary Confabulations:      ${report.confabulationCount} [Target 0]`);
  console.log(`Unhedged Stale Assertions:  ${report.unhedgedStaleCount} [Target 0]`);
  console.log(`Canary Session Leakage:     ${report.canaryLeakageCount} [Target 0]`);
  console.log(`Local Command Arg Leaks:    ${report.localCommandArgLeakCount} [Target 0]`);
  console.log(`STT Baseline Error Rate:    ${report.transcriptionErrorRate}%`);
  console.log('----------------------------------------------------');
  console.log(`Report JSON:                ${report.artefactPaths.reportJson}`);
  console.log(`Summary MD:                 ${report.artefactPaths.summaryMd}`);
  console.log('====================================================\n');

  if (report.cardFiled) {
    console.log(`[ALERT] Failure card generated: "${report.cardFiled.title}"`);
  }

  if (!report.passed && report.gatesDeploy) {
    console.error('Recall harness regression detected under gating policy.');
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal harness runner error:', err);
  process.exit(1);
});
