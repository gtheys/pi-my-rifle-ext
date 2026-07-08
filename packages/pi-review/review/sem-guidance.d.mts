// AIDEV-NOTE: Loose type declarations for the review sem-guidance glue module.
export declare function getSemToolAvailability(activeToolNames?: string[]): {
  [key: string]: boolean
}
export declare function buildSemReviewGuidance(
  target: unknown,
  toolsInput: unknown,
): string
