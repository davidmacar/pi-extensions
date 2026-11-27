/**
 * Pi only retries an assistant error when its own allow-list recognises the text
 * (`isRetryableAssistantError` in pi-ai). A channel that dies mid-stream is not on
 * that list, so Pi abandons the run and this extension never gets the `retry`
 * routing decision it is built for.
 *
 * `message_end` can return a replacement message, and Pi applies it in place
 * before it decides whether to retry. Annotating the error with the provider's
 * own class name for this failure puts it on the list, so the retry happens
 * through Pi's normal path and the chain rotates there.
 *
 * The annotation is additive: the provider's original text stays first, so the
 * human still reads what actually happened.
 */
export const RETRYABLE_MARKER = "upstream_stream_read_error";

/**
 * @param {unknown} errorMessage
 * @returns {string | undefined} the annotated text, or undefined when nothing should change
 */
export function retryableErrorText(errorMessage) {
  if (typeof errorMessage !== "string" || errorMessage.trim() === "") return undefined;
  if (errorMessage.includes(RETRYABLE_MARKER)) return undefined;
  return `${errorMessage} [failover-router: ${RETRYABLE_MARKER}]`;
}
