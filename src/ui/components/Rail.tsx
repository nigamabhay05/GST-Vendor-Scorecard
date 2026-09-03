import type { ScreenId } from '../screens/screens';
import { SCREENS } from '../screens/screens';
import { PrivacyLine } from './primitives';

/**
 * The fixed left rail: six numbered steps, in the order the work actually happens.
 *
 * The privacy line lives at its foot, as plain text rather than a badge. It is a
 * statement of fact about how the tool works, not a marketing claim, and dressing it up
 * would make it read like one.
 */
export function Rail({
  current,
  onNavigate,
  available,
  blocked,
}: {
  current: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  available: ReadonlySet<ScreenId>;
  blocked: boolean;
}) {
  return (
    <nav
      aria-label="Steps"
      className="border-rule bg-sheet flex w-56 shrink-0 flex-col justify-between border-r"
    >
      <div className="pt-6">
        <div className="px-5 pb-5">
          <p className="text-ink text-[13px] leading-tight font-semibold">
            Vendor GST
            <br />
            Compliance Scorecard
          </p>
        </div>

        <ol className="border-rule border-t">
          {SCREENS.map((screen, index) => {
            const isCurrent = screen.id === current;
            const isAvailable = available.has(screen.id);
            const isBlockedTarget = blocked && screen.requiresHealthAcknowledged;

            return (
              <li key={screen.id} className="border-rule border-b">
                <button
                  type="button"
                  disabled={!isAvailable || isBlockedTarget}
                  aria-current={isCurrent ? 'step' : undefined}
                  onClick={() => {
                    onNavigate(screen.id);
                  }}
                  className={[
                    'flex w-full items-baseline gap-3 px-5 py-3 text-left text-[13px]',
                    isCurrent ? 'text-accent font-semibold' : 'text-ink',
                    !isAvailable || isBlockedTarget
                      ? 'text-ink-muted cursor-not-allowed opacity-45'
                      : 'hover:bg-field cursor-pointer',
                  ].join(' ')}
                >
                  <span className="num text-ink-muted text-[11px]">{index + 1}</span>
                  <span>{screen.label}</span>
                </button>
              </li>
            );
          })}
        </ol>

        {blocked && (
          <p className="text-flag-amber px-5 py-3 text-[12px]">
            Data health needs your attention before results can be shown.
          </p>
        )}
      </div>

      <div className="border-rule border-t px-5 py-4">
        <PrivacyLine />
      </div>
    </nav>
  );
}
