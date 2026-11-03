import { describe, expect, it } from 'vitest';
import { openPathToastKey } from '../openPathToast';
import { en } from '../../i18n/locales/en';
import { zh } from '../../i18n/locales/zh';

describe('openPathToastKey', () => {
  it('maps every main-side openPath code to the toast for what happened', () => {
    expect(openPathToastKey('BLOCKED_EXTENSION')).toBe('terminal.openPathBlocked');
    expect(openPathToastKey('NOT_FOUND_OPENED_PARENT')).toBe('terminal.openPathMissingParent');
    expect(openPathToastKey('NOT_FOUND')).toBe('terminal.openPathNotFound');
    expect(openPathToastKey('LOOKUP_TIMEOUT')).toBe('terminal.openPathNotFound');
    // An existing file with no handler: main revealed it in its folder.
    expect(openPathToastKey('No application is associated')).toBe('terminal.openPathFailed');
    expect(openPathToastKey(undefined)).toBe('terminal.openPathFailed');
  });

  it('every key it can return is translated', () => {
    for (const code of ['BLOCKED_EXTENSION', 'NOT_FOUND_OPENED_PARENT', 'NOT_FOUND', 'x']) {
      const key = openPathToastKey(code);
      expect(en[key]).toBeTruthy();
      expect(zh[key]).toBeTruthy();
    }
  });
});
