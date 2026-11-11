/**
 * Cierra una frase que termina en una fecha u hora. En es-MX la hora ya termina en punto («1:28 p.m.»),
 * así que no se agrega otro: «… · 1:28 p.m. Mientras tanto…», nunca «p.m..».
 */
export const conPunto = (texto: string) => (texto.endsWith(".") ? texto : `${texto}.`);
