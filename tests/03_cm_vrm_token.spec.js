import { test, expect } from '@playwright/test';

const MODULES = [
  'Portfolio',
  'Rating and Risk Vector Alerts',
  'Incidents',
  'Application Configuration',
  'Scheduled Data Imports',
  'Dashboard',
  'About Bitsight',
  'Contact Support',
  'App Privacy Policy',
];

// Shared navigation: search for "bitsight" in the nav filter so module links are visible
async function filterBitsightModules(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByText('All').first().click();

  const filter = page.getByRole('textbox', { name: 'Enter search term to filter' });
  await filter.click();
  await filter.fill('bitsight');
  await filter.press('Enter');
}

test('TC-01: Verify all Bitsight VRM modules are reachable', async ({ page }) => {
  await filterBitsightModules(page);

  for (const module of MODULES) {
    const link = page.getByRole('link', {
      name: new RegExp(`^${module} \\d+ of \\d+$`),
    });
    await expect(link).toBeVisible();
    await link.click();
  }
});

test('TC-02: Valid Bitsight token (CM + VRM) validates successfully and reveals config sections', async ({ page }) => {
  test.setTimeout(240000); // 4 min overall, since validation can take up to ~3 min

  if (!process.env.CMVRM_TOKEN) {
    throw new Error('CMVRM_TOKEN is not set in .env');
  }

  await filterBitsightModules(page);
  await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

  const gsftFrame = page.frameLocator('iframe[name="gsft_main"]');

  // Enter a valid token that has both CM and VRM licenses active
  const tokenField = gsftFrame.locator('#token');
  await tokenField.click();
  await tokenField.fill(process.env.CMVRM_TOKEN);
  await gsftFrame.getByRole('button', { name: 'Validate Token' }).click();

  // --- Wait for the Success dialog to appear (validation can take 2-3 min) ---
  const successDialog = gsftFrame.getByRole('dialog', { name: 'Success' });
  await expect(successDialog).toBeVisible({ timeout: 200000 }); // just under the 240s test budget

  // Acknowledge it
  const okButton = successDialog.getByRole('button', { name: 'OK', exact: true });
  await okButton.click();

  // --- Assert: Token field retains the entered value ---
  await expect(tokenField).toHaveValue(process.env.CMVRM_TOKEN);

  // --- Assert: License status table is visible with both products listed ---
  const licenseTable = gsftFrame.locator('#bs_token').getByRole('table');
  await expect(licenseTable).toBeVisible();
  await expect(licenseTable.getByRole('row', { name: /Continuous Monitoring/ })).toBeVisible();
  await expect(licenseTable.getByRole('row', { name: /Risk Monitoring/ })).toBeVisible();

  await expect(licenseTable.getByRole('row', { name: /Continuous Monitoring/ }))
    .toContainText(/\d+\/\d+/);
  await expect(licenseTable.getByRole('row', { name: /Risk Monitoring/ }))
    .toContainText(/\d+\/\d+/);

  // --- Assert: Configuration options section becomes visible post-validation ---
const configSection = gsftFrame.locator('#bs-tprm-config');
await expect(configSection).toBeVisible();
await expect(configSection.getByText('Insert Bitsight companies that do not match existing company records in ServiceNow', { exact: true })).toBeVisible();
await expect(configSection.getByText('Mark all imported Bitsight companies as Vendors', { exact: true })).toBeVisible();
await expect(configSection.getByText('Rules for Automation of Incident creation based on Bitsight Alerts', { exact: true })).toBeVisible();
await expect(configSection.getByText('Create Incident on Score Change', { exact: true })).toBeVisible();
await expect(configSection.getByText('Bitsight Rating Drop Trigger', { exact: true })).toBeVisible();
await expect(configSection.getByText('Create Incident on Bitsight alerts with "Critical Decrease" Severity', { exact: true })).toBeVisible();
await expect(configSection.getByText('Create Incidents on Bitsight alerts with "Decrease" Severity', { exact: true })).toBeVisible();
await expect(configSection.getByText('Incident Assignment', { exact: true })).toBeVisible();
await expect(configSection.getByText('Incident Caller', { exact: true })).toBeVisible();
await expect(configSection.getByRole('button', { name: 'Save' })).toBeVisible();

  // --- Assert: Disable/Clear Token section becomes visible post-validation ---
  const clearTokenSection = gsftFrame.locator('#bs-clear-token');
await expect(clearTokenSection).toBeVisible();
await expect(clearTokenSection.getByText('Disable Bitsight Integration', { exact: true })).toBeVisible();
await expect(clearTokenSection.getByText('Clear Bitsight API token', { exact: true })).toBeVisible();
await expect(clearTokenSection.getByRole('button', { name: 'Clear Token' })).toBeVisible();
});