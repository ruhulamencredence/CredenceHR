-- Conveyance Disbursement filter test data (test database admin_ui).
-- Six bills, dates relative to today: Finance (Rafiq x3, Sadia), MIS (Tanvir), one old.
UPDATE all_employees SET branch = 'Head Office' WHERE id IN (36, 46, 47, 48, 50);
UPDATE all_employees SET branch = 'Gulshan Site' WHERE id = 37;
UPDATE all_employees SET employee_id = 'EMP-0048' WHERE id = 48;
UPDATE all_employees SET employee_id = 'EMP-0037' WHERE id = 37;
DELETE i FROM conveyance_bill_items i JOIN conveyance_bills b ON b.id = i.bill_id WHERE b.remarks = 'QA disb';
DELETE FROM conveyance_bills WHERE remarks = 'QA disb';
DELETE FROM bill_claim_items WHERE description = 'QA disb';
DELETE FROM bill_claims WHERE description = 'QA disb';
-- two Bill Claims: Food (Rafiq), Transport (Sadia)
INSERT INTO bill_claims (user_id, claim_date, from_date, to_date, amount, category, description, status) VALUES
  (138, CURDATE(), CURDATE(), CURDATE(), 900, 'Food', 'QA disb', 'approved'),
  (137, CURDATE(), CURDATE(), CURDATE(), 1500, 'Transport', 'QA disb', 'approved');
INSERT INTO bill_claim_items (bill_claim_id, category_name, bill_date, amount, description)
  SELECT id, category, claim_date, amount, 'QA disb' FROM bill_claims WHERE description = 'QA disb';
-- bills
INSERT INTO conveyance_bills (user_id, bill_date, remarks, is_disbursed, voucher_no, disbursed_at, disbursed_by) VALUES
  (138, DATE_FORMAT(CURDATE(), '%Y-%m-02'), 'QA disb', 0, NULL, NULL, NULL),          -- A Rafiq, food 900, pending
  (138, DATE_FORMAT(CURDATE(), '%Y-%m-03'), 'QA disb', 0, NULL, NULL, NULL),          -- B Rafiq, manual 300, pending
  (138, DATE_FORMAT(CURDATE(), '%Y-%m-01'), 'QA disb', 1, 'PV-QA-77', NOW(), 1),     -- C Rafiq, check in/out 2000, disbursed by Superadmin
  (137, DATE_FORMAT(CURDATE(), '%Y-%m-04'), 'QA disb', 0, NULL, NULL, NULL),          -- D Sadia, transport 1500, pending
  (132, DATE_FORMAT(CURDATE(), '%Y-%m-05'), 'QA disb', 0, NULL, NULL, NULL),          -- E Tanvir (MIS), manual 450, pending
  (132, '2025-03-10', 'QA disb', 1, 'PV-QA-OLD', '2025-03-15 10:00:00', 1);           -- F Tanvir, old, manual 200, disbursed
SET @a = (SELECT MIN(id) FROM conveyance_bills WHERE remarks = 'QA disb');
INSERT INTO conveyance_bill_items (bill_id, source, bill_claim_id, entry_date, particulars, amount) VALUES
  (@a, 'bill_claim', (SELECT id FROM bill_claims WHERE description = 'QA disb' AND user_id = 138), CURDATE(), 'Team lunch', 900),
  (@a + 3, 'bill_claim', (SELECT id FROM bill_claims WHERE description = 'QA disb' AND user_id = 137), CURDATE(), 'Site visit', 1500);
INSERT INTO conveyance_bill_items (bill_id, source, entry_date, particulars, amount) VALUES
  (@a + 1, 'manual', CURDATE(), 'Rickshaw', 300),
  (@a + 2, 'movement_claim', CURDATE(), 'Bank visit', 2000),
  (@a + 4, 'manual', CURDATE(), 'CNG', 450),
  (@a + 5, 'manual', '2025-03-10', 'Bus', 200);
