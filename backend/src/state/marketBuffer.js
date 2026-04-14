export function createCandleBuffer({ max }) {
  const arr = [];
  return {
    push(c) {
      if (arr.length && Number(arr[arr.length - 1]?.ts) === Number(c?.ts)) {
        arr[arr.length - 1] = { ...arr[arr.length - 1], ...c };
      } else {
        arr.push(c);
      }
      while (arr.length > max) arr.shift();
    },
    size() {
      return arr.length;
    },
    clear() {
      arr.length = 0;
    },
    last() {
      return arr.length > 0 ? arr[arr.length - 1] : null;
    },
    raw() {
      return arr;
    },
    toArray() {
      return arr.slice();
    },
  };
}
