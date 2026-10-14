/** Count LF-delimited model lines without allocating an array of every line. */
export function countLines(text: string) {
  let count = 1;
  for (let offset = text.indexOf('\n'); offset !== -1; offset = text.indexOf('\n', offset + 1))
    count++;
  return count;
}
