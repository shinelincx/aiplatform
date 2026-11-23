import { redirect } from 'next/navigation';
import { settingsPath } from '../workspace';

export default function SettingsIndex() {
  redirect(settingsPath('account'));
}
