import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SupplierFlag } from '../../engine/types';
import { formatInr, formatInrCompact, formatInrExact } from '../format';

/**
 * The small shared pieces. Hairlines, tabular figures and text labels do the work here;
 * there are no cards and no shadows anywhere in this file by design.
 */

// ------------------------------------------------------------------- flags

interface FlagPresentation {
  label: string;
  glyph: string;
  className: string;
}

/**
 * Colour never carries meaning on its own.
 *
 * Every flag has a text label and a distinct glyph as well as a colour, so the scorecard
 * survives being printed in greyscale, photocopied, or read by someone with a colour
 * vision deficiency -- all three of which happen to audit working papers routinely.
 */
export const FLAG_PRESENTATION: Record<SupplierFlag, FlagPresentation> = {
  red: { label: 'At risk', glyph: '■', className: 'text-flag-red bg-flag-red-tint' },
  amber: { label: 'Watch', glyph: '▲', className: 'text-flag-amber bg-flag-amber-tint' },
  green: { label: 'OK', glyph: '●', className: 'text-flag-green bg-flag-green-tint' },
  // Its own shape and word, not a shade between amber and red: this is not a worse
  // supplier, it is a decision waiting on the reader.
  user_action: {
    label: 'Your action',
    glyph: '◆',
    className: 'text-accent bg-accent-tint',
  },
  insufficient_history: {
    label: 'Insufficient history',
    glyph: '–',
    className: 'text-flag-grey bg-flag-grey-tint',
  },
};

export function FlagChip({ flag }: { flag: SupplierFlag }) {
  const presentation = FLAG_PRESENTATION[flag];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 text-[12px] whitespace-nowrap ${presentation.className}`}
    >
      <span aria-hidden="true">{presentation.glyph}</span>
      {presentation.label}
    </span>
  );
}

export function DeadlineChip({ flag }: { flag: 'ok' | 'amber' | 'red' | 'expired' }) {
  const map = {
    ok: { label: 'In time', glyph: '●', className: 'text-flag-green bg-flag-green-tint' },
    amber: { label: 'Approaching', glyph: '▲', className: 'text-flag-amber bg-flag-amber-tint' },
    red: { label: 'Act now', glyph: '■', className: 'text-flag-red bg-flag-red-tint' },
    expired: { label: 'Expired', glyph: '✕', className: 'text-flag-red bg-flag-red-tint' },
  } as const;
  const presentation = map[flag];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 text-[12px] whitespace-nowrap ${presentation.className}`}
    >
      <span aria-hidden="true">{presentation.glyph}</span>
      {presentation.label}
    </span>
  );
}

// ------------------------------------------------------------- info affordance

/**
 * The explanation attached to a derived figure.
 *
 * A real button rather than a hover-only tooltip: the rule behind a number has to be
 * reachable by keyboard and by a screen reader, because the user's job is to defend that
 * number to somebody else.
 */
export interface NoteSection {
  label: string;
  body: string;
}

/** Panel width in pixels. Must match the `w-80` class on the panel below. */
const NOTE_WIDTH = 320;
const NOTE_MARGIN = 8;
const NOTE_GAP = 6;

export function InfoNote({
  label,
  text,
  sections,
}: {
  label: string;
  /** A single sentence. Use this or `sections`, not both. */
  text?: string;
  /** Labelled parts -- Meaning, Formula, Criteria -- for the headline figures. */
  sections?: readonly NoteSection[];
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  /*
   * The panel is positioned in viewport coordinates rather than relative to the button.
   *
   * Two things in this app defeat an absolutely-positioned popover. The supplier table
   * lives inside an `overflow-x-auto` wrapper, and a container that clips one axis clips
   * the other too -- so a note opened on a column header was being cut off entirely. And
   * the sticky table headers carry their own z-index, which tied with the note's and won
   * on DOM order, painting the header over the KPI explanations.
   *
   * Anchoring to `getBoundingClientRect` and rendering `fixed` steps outside both
   * problems at once, and keeps working wherever a note is placed in future.
   */
  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const overflowsRight = rect.left + NOTE_WIDTH > window.innerWidth - NOTE_MARGIN;

    setPosition({
      top: rect.bottom + NOTE_GAP,
      // Flip to sit under the button's right edge rather than run off the screen.
      left: overflowsRight
        ? Math.max(NOTE_MARGIN, window.innerWidth - NOTE_WIDTH - NOTE_MARGIN)
        : rect.left,
    });
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    place();

    // `true` catches scrolling inside the table wrapper, not just the page.
    const reposition = () => {
      place();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    /*
     * Closed by a click outside rather than by the button losing focus. Blur would fire
     * the moment a reader put their cursor into the panel, which would make it
     * impossible to select a formula and paste it into a working paper -- exactly what
     * this audience will want to do with it.
     */
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapperRef.current?.contains(target)) return;
      setOpen(false);
    };

    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);

    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, place]);

  return (
    <span ref={wrapperRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`What ${label} means and how it is calculated`}
        onClick={() => {
          setOpen((wasOpen) => !wasOpen);
        }}
        className="text-ink-muted hover:text-accent border-rule ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border align-middle text-[10px] leading-none"
      >
        i
      </button>
      {open && position && (
        <span
          id={id}
          role="note"
          style={{ top: position.top, left: position.left }}
          className="border-rule bg-sheet text-ink fixed z-50 block w-80 border p-3 text-[13px] leading-snug"
        >
          {sections
            ? sections.map((section, index) => (
                <span
                  key={section.label}
                  className={index > 0 ? 'border-rule mt-2 block border-t pt-2' : 'block'}
                >
                  <span className="text-ink-muted block text-[11px]">{section.label}</span>
                  <span className="text-ink mt-0.5 block">{section.body}</span>
                </span>
              ))
            : text}
        </span>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ money

/**
 * A rupee figure. Rounded on screen, exact on hover and to a screen reader.
 *
 * The exact value rides on `title` *and* on the accessible name, because a partner
 * checking a figure against a ledger needs the paise and cannot get them from a
 * mouse-only affordance.
 */
export function Money({ value, compact = false }: { value: number; compact?: boolean }) {
  const exact = formatInrExact(value);
  const display = compact ? formatInrCompact(value).display : formatInr(value);

  return (
    <span className="num" title={exact} aria-label={exact}>
      {display}
    </span>
  );
}

// ------------------------------------------------------------------ layout

export function SectionHeading({
  children,
  note,
}: {
  children: ReactNode;
  note?: { label: string; text: string };
}) {
  return (
    <h2 className="text-ink flex items-center text-[16px] font-semibold">
      {children}
      {note && <InfoNote label={note.label} text={note.text} />}
    </h2>
  );
}

export function Rule() {
  return <hr className="border-rule my-0 border-0 border-t" />;
}

/** A pair of a small muted label above a figure, used all over the detail screens. */
export function Stat({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: { label: string; text: string };
}) {
  return (
    <div>
      <div className="text-ink-muted flex items-center text-[11px]">
        {label}
        {note && <InfoNote label={note.label} text={note.text} />}
      </div>
      <div className="text-ink mt-0.5 text-[15px]">{children}</div>
    </div>
  );
}

/**
 * Empty and error states say what happened and what to do next, never mood.
 */
export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning' | 'error';
  title: string;
  children?: ReactNode;
}) {
  const toneClass =
    tone === 'error'
      ? 'border-flag-red bg-flag-red-tint'
      : tone === 'warning'
        ? 'border-flag-amber bg-flag-amber-tint'
        : 'border-rule bg-field';

  return (
    <div className={`border-l-2 px-4 py-3 ${toneClass}`}>
      <p className="text-ink text-[14px] font-semibold">{title}</p>
      {children && <div className="text-ink-muted mt-1 text-[13px]">{children}</div>}
    </div>
  );
}

export function PrivacyLine({ className = '' }: { className?: string }) {
  return (
    <p className={`text-ink-muted text-[12px] ${className}`}>
      Your files are processed in this browser. Nothing is uploaded.
    </p>
  );
}
