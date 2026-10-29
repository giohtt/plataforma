import Image from "next/image";
import styles from "./page.module.css";

export default function Inicio() {
  return (
    <main className="contenedor">
      <header className={styles.cabecera}>
        <Image
          src="/brand/fitnessland-logo.png"
          alt="Fitness Land · Health & Sport Center"
          width={345}
          height={217}
          priority
          className={styles.logo}
        />
        <div>
          <h1 className={styles.titulo}>Plataforma administrativa</h1>
          <p className="sub">Sitio en preparación</p>
        </div>
      </header>

      <section className="tarjeta" aria-labelledby="estado-titulo">
        <h2 id="estado-titulo" className={styles.h2}>
          Todavía no hay usuarios, sucursales ni datos
        </h2>
        <p className={styles.texto}>
          Esta es la base técnica de la plataforma. La primera entrega añadirá, en este orden:
        </p>
        <ol className={styles.lista}>
          <li>Base de datos y migraciones.</li>
          <li>Inicio y cierre de sesión con usuarios individuales de prueba.</li>
          <li>Permisos y asignación de sucursales.</li>
          <li>Catálogo de sucursales que se conserva al recargar.</li>
          <li>Pruebas de acceso permitido y denegado.</li>
        </ol>
        <p className="sub">
          Los cobros, las visitas y los demás módulos no están conectados. Los respaldos y la
          restauración probada son requisito antes de usar datos reales.
        </p>
      </section>
    </main>
  );
}
