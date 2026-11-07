// Which milestone the Factory page's Board asks for, and which answer it shows (#32). The server works out its default milestone afresh at every read, so the page keeps the one it was first given
// (the pin) and asks for that; the one the viewer picks wins over it. Kept apart from Factory.tsx so the rules can be checked without a DOM: its effects do not run in the markup the tests render.
import type { BoardData } from './Factory.tsx';

export type Pin = { project: string; milestone: string } | undefined;

/** The milestone to ask for: the one picked, else the pin when it is this project's; none: let the server choose. */
export const askFor = (picked: string | undefined, pin: Pin, project: string) => picked ?? (pin?.project === project ? pin.milestone : undefined);

/** The pin after an answer: the milestone the server chose when none was asked for, if it chose one; else as it was. */
export const pinAfter = (asked: string | undefined, body: Pick<BoardData, 'milestone'>, project: string, pin: Pin): Pin => (!asked && body.milestone !== null ? { project, milestone: body.milestone } : pin);

/** The last answer, when it is for the milestone asked for (or none was asked for): a pick that failed never shows the old milestone's rows as if they were the picked one's. */
export const boardFor = (last: BoardData | undefined, asked: string | undefined) => (last && (!asked || last.milestone === asked) ? last : undefined);
