import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
export default function RichText({ text }: { text: string }) {
  return (
    <span className="study-rich">
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          p: ({ children }) => <span className="rich-paragraph">{children}</span>,
          img: () => null,
        }}
      >
        {text}
      </ReactMarkdown>
    </span>
  );
}
