import { CabeceraMarca } from "@/components/CabeceraMarca";
import { requerirSesion } from "@/lib/sesion-servidor";
import styles from "./page.module.css";

export default async function Inicio() {
  const sesion = await requerirSesion();
  return (
    <main className="contenedor">
      <CabeceraMarca titulo="Plataforma administrativa" subtitulo={`Bienvenida o bienvenido, ${sesion.nombre}`} />
      <section className="tarjeta" aria-labelledby="estado-titulo">
        <h2 id="estado-titulo" className={styles.h2}>
          Tu cuenta todavía no tiene perfiles ni sucursales asignados
        </h2>
        <p className={styles.texto}>
          Iniciaste sesión con tu cuenta individual. Lo que podrás ver y hacer depende de los perfiles y las sucursales
          que te asignen, y eso llega en el siguiente paso de la primera entrega.
        </p>
        <ol className={styles.lista}>
          <li>Base de datos y migraciones. ✅</li>
          <li>Inicio y cierre de sesión con usuarios individuales de prueba. ✅</li>
          <li>Permisos y asignación de sucursales.</li>
          <li>Catálogo de sucursales que se conserva al recargar.</li>
          <li>Pruebas de acceso permitido y denegado.</li>
        </ol>
        <p className="sub">
          Los cobros, las visitas y los demás módulos no están conectados. Los respaldos y la restauración probada son
          requisito antes de usar datos reales.
        </p>
      </section>
    </main>
  );
}
