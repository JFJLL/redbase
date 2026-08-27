const ACTIVE_PROJECT_STATUSES = new Set([
  "preparing",
  "queued",
  "running",
  "processing_result",
  "result_processing_failed",
  "partial_failed",
  "uncertain",
  "waiting_configuration",
  "assembling",
  "assembly_failed",
]);

const RECOVERABLE_PROJECT_STATUSES = new Set([
  "preparing",
  "queued",
  "running",
  "processing_result",
  "waiting_configuration",
  "assembling",
]);

const TERMINAL_PROJECT_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "assembly_failed",
  "project_data_failed",
]);

module.exports = {
  ACTIVE_PROJECT_STATUSES,
  RECOVERABLE_PROJECT_STATUSES,
  TERMINAL_PROJECT_STATUSES,
};

