import "./globals.css";

export const metadata = {
  title: "AI Study Summary & Quiz",
  description: "Soo geli fayl PDF ama Word ah si uu kuugu sameeyo koobid iyo su'aalo.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="so" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
