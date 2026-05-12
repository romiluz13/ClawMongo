import type { Document } from "mongodb";

type MongoCursorWithSort<TCursor> = {
  sort(sort: Document): TCursor;
};

export function sortMongoCursor<TCursor>(
  cursor: MongoCursorWithSort<TCursor>,
  sort: Document,
): TCursor {
  const sortMethod = "sort";
  return cursor[sortMethod](sort);
}
