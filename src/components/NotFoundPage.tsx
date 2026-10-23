import { useEffect } from "react";

export function NotFoundPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "404: This page could not be found.";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.appendChild(robots);
    return () => {
      document.title = previousTitle;
      robots.remove();
    };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 text-black">
      <div className="flex items-center">
        <h1 className="mr-5 border-r border-black/30 pr-5 text-2xl font-medium leading-[49px]">404</h1>
        <h2 className="text-sm font-normal leading-[49px]">This page could not be found.</h2>
      </div>
    </main>
  );
}
