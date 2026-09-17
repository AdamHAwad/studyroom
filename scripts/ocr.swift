import Foundation
import Vision
import AppKit
import PDFKit
func recognize(_ image: CGImage) throws -> String {
 let request = VNRecognizeTextRequest()
 request.recognitionLevel = .accurate
 request.usesLanguageCorrection = true
 try VNImageRequestHandler(cgImage: image).perform([request])
 return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
do {
 if url.pathExtension.lowercased() == "pdf", let pdf = PDFDocument(url:url) {
  for i in 0..<pdf.pageCount {
   guard let page = pdf.page(at:i) else { continue }
   print("[Page \(i+1)]")
   if let s = page.string, s.trimmingCharacters(in:.whitespacesAndNewlines).count > 20 {print(s);continue}
   let bounds=page.bounds(for:.mediaBox)
   let image=page.thumbnail(of:NSSize(width:bounds.width*2,height:bounds.height*2),for:.mediaBox)
   guard let cg=image.cgImage(forProposedRect:nil,context:nil,hints:nil) else {continue}
   print(try recognize(cg))
  }
 } else {
  guard let image=NSImage(contentsOf:url),let cg=image.cgImage(forProposedRect:nil,context:nil,hints:nil) else {throw NSError(domain:"Unreadable image",code:1)}
  print("[Image]")
  print(try recognize(cg))
 }
} catch {fputs("OCR failed: \(error)\n",stderr);exit(1)}
