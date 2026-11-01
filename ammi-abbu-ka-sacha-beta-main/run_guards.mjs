/**
 * run_guards.mjs — guard suite ko DETERMINISTIC tarike se chalata hai.
 *
 * Pehle tests ek hi `data/db.json` par line-se-line chalte the: ek test jo apna
 * state saaf nahi karta, agle test ko tod deta tha (v23 ka fake tracking link
 * v26 ko, v51 ko bhi). Store ab data honest tareeke se rakhta hai, isliye har
 * test ko apna saaf DB milna chahiye.
 *
 * Har test ke pehle `data/db.json` + `accounts.json` hata diye jaate hain (test
 * khud apna state banata hai), aakhir me bhi saaf.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const TESTS = [
  "test_v16_url_only_address_and_order_card_e2e.mjs",
  "test_v17_customer_auto_offer_e2e.mjs",
  "test_v19_share_link_only_e2e.mjs",
  "test_v20_single_card_chat_e2e.mjs",
  "test_v21_personalised_qr_prompts_and_routing_e2e.mjs",
  "test_v22_orders_done_all_ids_e2e.mjs",
  "test_v23_auto_tracking_dashboard_e2e.mjs",
  "test_v24_extract_tracking_fix_e2e.mjs",
  "test_v25_finished_order_otp_status_e2e.mjs",
  "test_v26_real_tracking_and_delivered_links_e2e.mjs",
  "test_v18_auto_bill_summary_and_tracking_e2e.mjs",
  "test_v35_ammi_abbu_topics_progression_e2e.mjs",
  "test_v36_login_prefetch_logout_autoselect_duallink_e2e.mjs",
  "test_v37_order_count_id_assign_choose_diagnostic_e2e.mjs",
  "test_v38_accounts_logout_purge_order_count_display_e2e.mjs",
  "test_v39_file_sequential_intake_order_count_logout_all_e2e.mjs",
  "test_v40_simple_chat_consent_tracking_e2e.mjs",
  "test_v41_integrity_hardening_e2e.mjs",
  "test_v40_lazy_boss_autopilot_e2e.mjs",
  "test_v42_address_link_recovery_e2e.mjs",
  "test_v43_all_six_fixes_e2e.mjs",
  "test_v47_no_false_address_expiry_e2e.mjs",
  "test_v48_address_fetched_but_retry_e2e.mjs",
  "test_v49_payment_ofo_link_e2e.mjs",
  "test_v50_no_fake_incognito_e2e.mjs",
  "test_v51_active_orders_no_wipe_e2e.mjs",
  "test_v52_fast_id_selection_and_qr_deadline_e2e.mjs",
  "test_v53_instant_tracking_link_e2e.mjs",
  "test_v54_any_id_order_extraction_e2e.mjs",
  "test_v55_offer_cash_panel_e2e.mjs",
  "test_v56_user_controls_onoff_quantity_e2e.mjs",
  "test_v57_instant_id_rotation_e2e.mjs",
  "test_v58_auto_offer_claim_and_copy_json_e2e.mjs",
  "test_v59_export_logout_fix_auto_delivery_export_e2e.mjs",
  "test_v60_invalid_qr_and_same_qr_fix_e2e.mjs",
  "test_v61_account_suspension_failover_fast_id_e2e.mjs",
  "test_v62_offer_doctor_night_offer_e2e.mjs",
  "test_v63_no_loop_place_truth_amount_lock_e2e.mjs",
  "test_v64_perf_optimization_e2e.mjs",
  "test_v65_four_offers_every_import_e2e.mjs",
  "test_v66_four_offer_status_boss_and_user_e2e.mjs",
  "test_v67_fixed_offer_discovery_ladder_e2e.mjs",
  "test_v68_qr_applies_offer_before_place_e2e.mjs",
  "test_v69_bulk_files_and_honest_claim_e2e.mjs",
  "test_v70_karwa_chauth_and_customer_phone_login_e2e.mjs",
  "test_v71_order_account_lock_e2e.mjs",
  "test_v72_wallet_fee_e2e.mjs",
  "test_v73_qr_hold_release_and_fee_panel_e2e.mjs",
  "test_v74_tracking_id_adoption_e2e.mjs",
  "test_v75_payment_upi_panel_e2e.mjs",
  "test_v76_simple_flow_login_bill_qr_e2e.mjs",
  "test_v78_payment_truth_e2e.mjs",
  "test_v79_address_typed_never_dropped_e2e.mjs",
  "test_v80_phone_login_truth_e2e.mjs",
  "test_v81_fee_qr_then_order_qr_e2e.mjs",
  "test_v82_ofo_placement.mjs",
  "test_v83_ofo_proof_and_early_mode.mjs",
  "test_v84_maintenance_and_zero_order_scan.mjs",
  "test_v91_mini_app_ids_honest.mjs",
  "test_v92_miniapp_vault_selfsetup.mjs",
  "test_v93_miniapp_shared_accounts_and_polish.mjs",
  "test_v94_miniapp_cart_parity.mjs",
  "test_v95_miniapp_cart_import_and_backup.mjs",
  "test_v96_miniapp_cart_look_coupons_tracking.mjs",
  "test_v97_miniapp_bill_breakdown_coupons.mjs",
  "test_v98_miniapp_bill_summary_swiggy_lines.mjs",
  "test_v99_miniapp_checkout_reasons_and_signup.mjs",
  "test_v100_miniapp_wallet_ofo_autobill.mjs",
  "test_v101_qr_recovery_address_utr.mjs",
  "test_v102_idle_order_expiry.mjs",
  "test_v103_offer_engine_parity.mjs",
  "test_v104_qr_intent_truth_and_style.mjs",
  "test_v105_utr_and_qr_truth.mjs",
  "test_v106_possibility_matrix.mjs",
  "test_v107_bill_and_qr_possibilities.mjs",
  "test_v108_deployproof_tracking_autopay.mjs",
  "test_v109_utr_asli_paisa.mjs",
  "test_v110_tracking_and_sms_truth.mjs",
  "test_v111_login_id_durability.mjs",
  "test_v112_utr_fetch_and_credit.mjs",
  "test_v113_no_data_erase.mjs",
  "test_v114_utr_truth.mjs",
  "test_v115_durability_doctor.mjs",
  "test_v116_premium_look.mjs",
  "test_v117_reference_visual_system.mjs",
  "test_v118_one_page_no_lecture.mjs",
  "test_v119_visual_qa_fixes.mjs",
  "test_v120_accounts_reference_and_copy_json.mjs",
  "test_v121_five_minute_verify_and_share_link.mjs",
  "test_v122_round33_payment_actions_bill_speed_filters.mjs",
  "test_v123_round34_bill_faster_pay_window.mjs",
  "test_v124_round35_cancel_and_consistent_bill.mjs"
];

const CLEAN_FILES = ['data/db.json', 'accounts.json'];

function cleanState() {
  for (const f of CLEAN_FILES) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
}

const failed = [];
const t0 = Date.now();
for (const test of TESTS) {
  cleanState();
  const started = Date.now();
  const res = spawnSync(process.execPath, [test], { stdio: 'inherit', env: { ...process.env, GUARDS_RUN: '1' } });
  const ms = Date.now() - started;
  if (res.status !== 0) {
    failed.push({ test, status: res.status, ms });
    console.error(`\n❌ GUARD FAILED: ${test} (${ms}ms, exit ${res.status})\n`);
  } else {
    console.log(`\n✓ ${test} (${(ms / 1000).toFixed(1)}s)`);
  }
}
cleanState();

const total = Date.now() - t0;
console.log('\n' + '='.repeat(70));
if (failed.length === 0) {
  console.log(`🏆 GUARDS PASSED — ${TESTS.length}/${TESTS.length} suites, ${(total / 1000).toFixed(1)}s`);
} else {
  console.log(`❌ GUARDS FAILED — ${failed.length}/${TESTS.length} suites failed:`);
  for (const f of failed) console.log(`   • ${f.test} (exit ${f.status})`);
}
console.log('='.repeat(70));
process.exitCode = failed.length === 0 ? 0 : 1;
