export function getStableDeviceCode(deviceId: number) {
  let index = Math.max(0, Math.trunc(deviceId) - 1);
  let width = 2;
  let capacity = 26 ** width;

  while (index >= capacity) {
    index -= capacity;
    width += 1;
    capacity = 26 ** width;
  }

  let code = "";
  for (let position = 0; position < width; position += 1) {
    code = String.fromCharCode(97 + (index % 26)) + code;
    index = Math.floor(index / 26);
  }
  return code;
}
