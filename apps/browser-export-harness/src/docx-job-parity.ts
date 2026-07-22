import type { ExportReport } from "@atlcli/docx/browser";
import { unzipDocx } from "@atlcli/docx/scan";

export interface DocxParityRun {
  bytes: Uint8Array;
  report: ExportReport;
}

export interface DocxJobParityResult {
  partsIdentical: true;
  mediaIdentical: true;
  reportIdentical: true;
  partCount: number;
  mediaPartCount: number;
  byteLength: number;
}

interface DocxPart {
  name: string;
  bytes: Uint8Array;
}

/**
 * Project the stable DOCX report contract for direct-vs-job parity.
 *
 * Host clocks are intentionally absent: the scalar duration, detailed timing
 * aggregates and the derived `perf-timing` note all describe when a host ran,
 * not what it rendered. Every semantic field, note message/provenance and the
 * complete template scan remain exact.
 */
export function projectDocxReport(report: ExportReport): unknown {
  return {
    resolvedCount: report.resolvedCount,
    unsupportedNames: [...report.unsupportedNames],
    skippedImages: report.skippedImages,
    embeddedImages: report.embeddedImages,
    renderedDiagrams: report.renderedDiagrams,
    filename: report.filename,
    notes: report.notes
      .filter((note) => note.code !== "perf-timing")
      .map((note) => structuredClone(note)),
    ...(report.sourceNotes === undefined
      ? {}
      : { sourceNotes: report.sourceNotes.map((note) => structuredClone(note)) }),
    complete: report.complete,
    scan: structuredClone(report.scan),
  };
}

function readParts(bytes: Uint8Array): DocxPart[] {
  const zip = unzipDocx(bytes);
  return Object.keys(zip.files)
    .sort()
    .flatMap((name) => {
      const file = zip.file(name);
      return file ? [{ name, bytes: file.asUint8Array().slice() }] : [];
    });
}

function firstByteDifference(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/** Fail closed unless the job reproduces every decompressed DOCX part and report field. */
export function assertDocxJobParity(
  direct: DocxParityRun,
  job: DocxParityRun,
): DocxJobParityResult {
  const directParts = readParts(direct.bytes);
  const jobParts = readParts(job.bytes);
  const directNames = directParts.map(({ name }) => name);
  const jobNames = jobParts.map(({ name }) => name);
  if (JSON.stringify(directNames) !== JSON.stringify(jobNames)) {
    throw new Error(
      `Job DOCX part set diverged from the direct path. ` +
        `direct=${JSON.stringify(directNames)} job=${JSON.stringify(jobNames)}`,
    );
  }

  for (let index = 0; index < directParts.length; index += 1) {
    const directPart = directParts[index]!;
    const jobPart = jobParts[index]!;
    if (!equalBytes(directPart.bytes, jobPart.bytes)) {
      const offset = firstByteDifference(directPart.bytes, jobPart.bytes);
      throw new Error(
        `Job DOCX part ${directPart.name} diverged from the direct path at offset ${offset} ` +
          `(direct ${directPart.bytes.byteLength} bytes, job ${jobPart.bytes.byteLength} bytes).`,
      );
    }
  }

  const directReport = JSON.stringify(projectDocxReport(direct.report));
  const jobReport = JSON.stringify(projectDocxReport(job.report));
  if (directReport !== jobReport) {
    throw new Error(
      `Job DOCX report diverged from the direct path. direct=${directReport} job=${jobReport}`,
    );
  }

  const mediaPartCount = directParts.filter(({ name }) => /^word\/media\//i.test(name)).length;
  if (mediaPartCount === 0) {
    throw new Error("DOCX job parity fixture did not render a media part.");
  }

  return {
    partsIdentical: true,
    mediaIdentical: true,
    reportIdentical: true,
    partCount: directParts.length,
    mediaPartCount,
    byteLength: job.bytes.byteLength,
  };
}
