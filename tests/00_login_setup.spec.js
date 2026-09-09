import { test } from '@playwright/test';
import 'dotenv/config';

const authFile = 'playwright/.auth/user.json';

test('login and save session', async ({ page }) => {
  await page.goto(process.env.SN_URL, { waitUntil: 'domcontentloaded' });

  const usernameField = page.getByRole('textbox', { name: 'User name' });
  await usernameField.waitFor({ state: 'visible', timeout: 60_000 }); // give the slow instance room here specifically

  await usernameField.fill(process.env.SN_USER);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.SN_PASS);
  await page.getByRole('button', { name: 'Log in' }).click();

  await usernameField.waitFor({ state: 'hidden', timeout: 60_000 });

  await page.context().storageState({ path: authFile });
});